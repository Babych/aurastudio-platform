import io
import os
import time
import json
import base64
import subprocess
import urllib.request
import urllib.error
import traceback
import modal
from pydantic import BaseModel
from PIL import Image

app = modal.App("qwen-image-edit-service")

# Persistent Volume for caching models permanently
models_volume = modal.Volume.from_name("qwen-models-volume", create_if_missing=True)

# Build custom container image with CUDA, FlashAttention & ComfyUI dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libsm6", "libxext6", "wget", "curl", "build-essential")
    .pip_install(
        "torch>=2.4.0",
        "torchvision",
        "transformers>=4.46.0",
        "accelerate>=0.34.0",
        "safetensors",
        "sentencepiece",
        "pillow",
        "fastapi",
        "pydantic",
        "huggingface_hub",
        "einops",
        "scipy",
        "numpy",
        "gguf>=0.10.0"
    )
    .run_commands(
        # Clone ComfyUI + ComfyUI-GGUF inside the image
        "git clone https://github.com/comfyanonymous/ComfyUI.git /root/ComfyUI",
        "cd /root/ComfyUI/custom_nodes && git clone https://github.com/city96/ComfyUI-GGUF.git",
        "pip install -r /root/ComfyUI/requirements.txt",
        # Remove default models dir so we can symlink /models volume cleanly
        "rm -rf /root/ComfyUI/models"
    )
)

class EditRequest(BaseModel):
    image_base64: str
    prompt: str
    negative_prompt: str = ""
    steps: int = 25
    cfg: float = 3.4
    seed: int = 424242

def execute_qwen_workflow(image_bytes: bytes, prompt: str, negative_prompt: str = "", steps: int = 25, cfg: float = 3.4, seed: int = 424242) -> bytes:
    os.makedirs("/root/ComfyUI/input", exist_ok=True)
    input_filename = f"input_{int(time.time()*1000)}.png"
    input_path = f"/root/ComfyUI/input/{input_filename}"

    # Proportional 16-px alignment
    pil_raw = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    orig_w, orig_h = pil_raw.size
    
    max_side = 640
    scale = min(max_side / max(orig_w, orig_h), 1.0)
    target_w = max(512, int(orig_w * scale) // 16 * 16)
    target_h = max(512, int(orig_h * scale) // 16 * 16)

    resized_img = pil_raw.resize((target_w, target_h), Image.Resampling.LANCZOS)
    resized_img.save(input_path, format="PNG")

    print(f"[*] Executing Official Qwen Workflow ({target_w}x{target_h} | Steps: {steps} | CFG: {cfg})...")

    workflow = {
        "1": {
            "class_type": "LoadImage",
            "inputs": {
                "image": input_filename
            }
        },
        "4": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": "qwen_image_vae.safetensors"
            }
        },
        "26": {
            "class_type": "CLIPLoaderGGUF",
            "inputs": {
                "clip_name": "Qwen2.5-VL-7B-Instruct-q4_0.gguf",
                "type": "qwen_image"
            }
        },
        "28": {
            "class_type": "UnetLoaderGGUF",
            "inputs": {
                "unet_name": "qwen-image-edit-2511-uncensored-Q4_K_M.gguf"
            }
        },
        "16": {
            "class_type": "TextEncodeQwenImageEdit",
            "inputs": {
                "prompt": prompt,
                "clip": ["26", 0],
                "vae": ["4", 0],
                "image": ["1", 0]
            }
        },
        "25": {
            "class_type": "TextEncodeQwenImageEdit",
            "inputs": {
                "prompt": negative_prompt or "blurry, low quality, distorted, bad anatomy, artifacts, malformed, low resolution",
                "clip": ["26", 0],
                "vae": ["4", 0],
                "image": ["1", 0]
            }
        },
        "30": {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["1", 0],
                "vae": ["4", 0]
            }
        },
        "12": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "model": ["28", 0],
                "positive": ["16", 0],
                "negative": ["25", 0],
                "latent_image": ["30", 0]
            }
        },
        "13": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["12", 0],
                "vae": ["4", 0]
            }
        },
        "14": {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "modal_qwen_out",
                "images": ["13", 0]
            }
        }
    }

    # Queue prompt
    payload = json.dumps({"prompt": workflow}).encode('utf-8')
    try:
        req = urllib.request.Request("http://127.0.0.1:8188/prompt", data=payload, headers={'Content-Type': 'application/json'})
        resp = urllib.request.urlopen(req)
        prompt_id = json.loads(resp.read().decode('utf-8')).get("prompt_id")
    except urllib.error.HTTPError as he:
        err_body = he.read().decode('utf-8')
        print(f"ComfyUI prompt error: {err_body}")
        raise RuntimeError(f"ComfyUI prompt rejected: {err_body}")
    
    # Poll for completion
    start_time = time.time()
    print(f"[*] Queued Prompt ID: {prompt_id} on A10G GPU...")

    while time.time() - start_time < 300:
        try:
            h_req = urllib.request.Request(f"http://127.0.0.1:8188/history/{prompt_id}")
            h_resp = urllib.request.urlopen(h_req)
            h_data = json.loads(h_resp.read().decode('utf-8'))
            if prompt_id in h_data:
                outputs = h_data[prompt_id].get("outputs", {})
                if "14" in outputs:
                    images = outputs["14"].get("images", [])
                    if images:
                        out_filename = images[0]["filename"]
                        out_subfolder = images[0].get("subfolder", "")
                        out_path = f"/root/ComfyUI/output/{out_subfolder}/{out_filename}" if out_subfolder else f"/root/ComfyUI/output/{out_filename}"
                        print(f"[+] Qwen generation finished in {round(time.time()-start_time, 2)}s! File: {out_path}")
                        with open(out_path, "rb") as f:
                            return f.read()
        except Exception:
            pass
        time.sleep(0.5)

    raise TimeoutError("Qwen execution exceeded 300s timeout")

@app.cls(
    image=image,
    gpu="L40S", # 48GB VRAM Nvidia Ada Lovelace GPU
    volumes={"/models": models_volume},
    timeout=600,
    scaledown_window=300, # Keep warm for 5 minutes
)
class QwenEditor:
    @modal.enter()
    def setup(self):
        import shutil
        from huggingface_hub import hf_hub_download
        print("[*] Setting up models directory & persistent volume...")
        
        # Symlink /root/ComfyUI/models to /models volume
        if not os.path.exists("/root/ComfyUI/models"):
            os.symlink("/models", "/root/ComfyUI/models")
            
        # Ensure all model directories exist
        os.makedirs("/models/diffusion_models", exist_ok=True)
        os.makedirs("/models/text_encoders", exist_ok=True)
        os.makedirs("/models/clip", exist_ok=True)
        os.makedirs("/models/clip_vision", exist_ok=True)
        os.makedirs("/models/vae", exist_ok=True)
        os.makedirs("/models/unet", exist_ok=True)
        
        repo_id = "ChrisColeTech/qwen-image-edit-uncensored-GGUF"
        
        # 1. VAE
        vae_path = "/models/vae/qwen_image_vae.safetensors"
        if not os.path.exists(vae_path) or os.path.getsize(vae_path) < 1000000:
            print("[+] Downloading qwen_image_vae.safetensors...")
            f = hf_hub_download(repo_id=repo_id, filename="split/vae/qwen_image_vae.safetensors")
            shutil.copy2(f, vae_path)
            
        # 2. Qwen2.5-VL text encoder
        vl_path = "/models/text_encoders/Qwen2.5-VL-7B-Instruct-q4_0.gguf"
        if not os.path.exists(vl_path) or os.path.getsize(vl_path) < 1000000:
            print("[+] Downloading Qwen2.5-VL-7B text encoder...")
            f = hf_hub_download(repo_id=repo_id, filename="split/text_encoders/Qwen2.5-VL-7B-Instruct-q4_0.gguf")
            shutil.copy2(f, vl_path)
            
        # 3. mmproj
        mmproj_path = "/models/text_encoders/Qwen2.5-VL-7B-Instruct-mmproj-f16.gguf"
        if not os.path.exists(mmproj_path) or os.path.getsize(mmproj_path) < 1000000:
            print("[+] Downloading Qwen2.5-VL mmproj...")
            f = hf_hub_download(repo_id=repo_id, filename="split/text_encoders/Qwen2.5-VL-7B-Instruct-mmproj-f16.gguf")
            shutil.copy2(f, mmproj_path)

        # 4. Uncensored DiT Q4_K_M
        dit_path = "/models/diffusion_models/qwen-image-edit-2511-uncensored-Q4_K_M.gguf"
        if not os.path.exists(dit_path) or os.path.getsize(dit_path) < 1000000:
            print("[+] Downloading qwen-image-edit-2511-uncensored-Q4_K_M.gguf...")
            f = hf_hub_download(repo_id=repo_id, filename="split/diffusion_models/qwen-image-edit-2511-uncensored-Q4_K_M.gguf")
            shutil.copy2(f, dit_path)

        # Cross-directory symlinks for seamless ComfyUI loader lookup
        for folder in ["/models/unet"]:
            dst = os.path.join(folder, "qwen-image-edit-2511-uncensored-Q4_K_M.gguf")
            if not os.path.exists(dst):
                try: os.symlink(dit_path, dst)
                except Exception: pass

        for folder in ["/models/clip", "/models/clip_vision"]:
            dst_mmproj = os.path.join(folder, "Qwen2.5-VL-7B-Instruct-mmproj-f16.gguf")
            if not os.path.exists(dst_mmproj):
                try: os.symlink(mmproj_path, dst_mmproj)
                except Exception: pass
            dst_vl = os.path.join(folder, "Qwen2.5-VL-7B-Instruct-q4_0.gguf")
            if not os.path.exists(dst_vl):
                try: os.symlink(vl_path, dst_vl)
                except Exception: pass

        models_volume.commit()
        print("[+] All Qwen models and symlinks ready in persistent volume!")
        ensure_comfyui_running()

    @modal.fastapi_endpoint(method="POST")
    def api_edit(self, req: EditRequest):
        try:
            ensure_comfyui_running()
            image_bytes = base64.b64decode(req.image_base64)
            result_bytes = execute_qwen_workflow(
                image_bytes=image_bytes,
                prompt=req.prompt,
                negative_prompt=req.negative_prompt,
                steps=req.steps,
                cfg=req.cfg,
                seed=req.seed
            )
            return {
                "status": "success",
                "result_base64": base64.b64encode(result_bytes).decode("utf-8")
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
                "traceback": traceback.format_exc()
            }

def ensure_comfyui_running():
    try:
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=1)
        return
    except Exception:
        pass

    print("[*] Starting local ComfyUI daemon on GPU...")
    log_file = open("/tmp/comfyui.log", "a")
    proc = subprocess.Popen([
        "python", "/root/ComfyUI/main.py",
        "--listen", "127.0.0.1",
        "--port", "8188",
        "--highvram",
        "--dont-upcast-attention",
        "--disable-auto-launch"
    ], stdout=log_file, stderr=log_file)

    for i in range(60):
        try:
            urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=1)
            print(f"[+] ComfyUI daemon is ready after {i * 0.5:.1f}s!")
            return
        except Exception:
            if proc.poll() is not None:
                log_file.flush()
                try:
                    with open("/tmp/comfyui.log", "r") as f:
                        err_content = f.read()
                except Exception:
                    err_content = "Could not read /tmp/comfyui.log"
                raise RuntimeError(f"ComfyUI exited prematurely with code {proc.returncode}: {err_content[-1000:]}")
            time.sleep(0.5)

    raise TimeoutError("ComfyUI daemon failed to respond within 30 seconds")
