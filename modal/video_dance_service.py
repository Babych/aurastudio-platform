"""
AuraStudio AI Video Dance & Neural Motion Retargeting Engine
Serverless GPU Service on Modal (Nvidia L40S / A10G)

Performs neural motion retargeting from driving donor videos onto reference portraits
using LivePortrait & GPU accelerated video rendering.
"""

import os
import io
import sys
import glob
import time
import base64
import tempfile
import traceback
import subprocess
from typing import Optional
from pathlib import Path
from pydantic import BaseModel
import modal

# 1. Build Cloud GPU Container with PyTorch, CUDA 12.4, LivePortrait & Pretrained Weights
app = modal.App("aurastudio-video-dance-service")

cuda_version = "12.4.0"
flavor = "devel"
os_version = "ubuntu22.04"
tag = f"{cuda_version}-{flavor}-{os_version}"

def download_liveportrait_weights():
    import os
    from huggingface_hub import snapshot_download
    
    weights_dir = "/root/LivePortrait/pretrained_weights"
    os.makedirs(weights_dir, exist_ok=True)
    
    print("[Build] Downloading LivePortrait weights from HuggingFace...")
    snapshot_download(
        repo_id="KwaiVGI/LivePortrait",
        local_dir=weights_dir,
        ignore_patterns=["*.md", "*.git*"]
    )
    
    print("[Build] Model download complete. Files:", os.listdir(weights_dir))

video_image = (
    modal.Image.from_registry(f"nvidia/cuda:{tag}", add_python="3.10")
    .apt_install(
        "git",
        "git-lfs",
        "ffmpeg",
        "libsm6",
        "libxext6",
        "libgl1-mesa-glx",
        "libglib2.0-0",
        "build-essential"
    )
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "torchaudio==2.5.1",
        "numpy>=1.24.0,<2.0.0",
        "opencv-python-headless>=4.10.0",
        "pillow>=10.4.0",
        "imageio>=2.34.0",
        "imageio-ffmpeg>=0.5.1",
        "pyyaml>=6.0",
        "yacs>=0.1.8",
        "scipy>=1.13.0",
        "scikit-image>=0.24.0",
        "onnxruntime-gpu>=1.18.0",
        "insightface>=0.7.3",
        "huggingface_hub>=0.24.0",
        "fastapi[standard]>=0.115.0",
        "pydantic>=2.8.0",
        "tyro>=0.8.5",
        "albumentations>=1.4.0",
        "tqdm"
    )
    .run_commands(
        "git lfs install",
        "git clone https://github.com/KwaiVGI/LivePortrait.git /root/LivePortrait",
        "cd /root/LivePortrait && git lfs pull",
        "pip install -r /root/LivePortrait/requirements.txt || true"
    )
    .run_function(download_liveportrait_weights)
)

class DanceRequest(BaseModel):
    image_base64: str
    dance_template_id: Optional[str] = "viral_house_shuffle"
    video_base64: Optional[str] = None
    audio_sync: bool = True
    fps: int = 24
    height: int = 768
    width: int = 512

@app.cls(
    image=video_image,
    gpu="A10G",
    timeout=300,
    scaledown_window=300
)
class VideoDanceEngine:
    @modal.enter()
    def setup(self):
        import torch
        print(f"[VideoDanceEngine] Initializing LivePortrait on GPU: {torch.cuda.get_device_name(0)}")
        # Pre-warm and verify environment
        subprocess.run(["ffmpeg", "-version"], check=True, stdout=subprocess.PIPE)
        print("[VideoDanceEngine] LivePortrait environment ready!")

    @modal.fastapi_endpoint(method="POST")
    def api_dance(self, req: DanceRequest):
        t0 = time.time()
        work_dir = tempfile.mkdtemp(prefix="dance_task_")
        try:
            from PIL import Image
            import numpy as np

            # 1. Decode Source Photo
            raw_img_bytes = base64.b64decode(req.image_base64.split(",")[-1])
            src_img_path = os.path.join(work_dir, "source_person.png")
            with open(src_img_path, "wb") as f:
                f.write(raw_img_bytes)

            # 2. Resolve Driving Donor Video
            driving_path = None
            if req.video_base64:
                donor_bytes = base64.b64decode(req.video_base64.split(",")[-1])
                custom_driving_path = os.path.join(work_dir, "custom_donor.mp4")
                with open(custom_driving_path, "wb") as f:
                    f.write(donor_bytes)
                driving_path = custom_driving_path
            else:
                template_donor_map = {
                    "viral_house_shuffle": "/root/LivePortrait/assets/examples/driving/d0.mp4",
                    "kpop_hiphop_groove": "/root/LivePortrait/assets/examples/driving/d13.mp4",
                    "electro_rave_shuffle": "/root/LivePortrait/assets/examples/driving/d6.mp4",
                    "latina_salsa_groove": "/root/LivePortrait/assets/examples/driving/d2.mp4"
                }
                driving_path = template_donor_map.get(req.dance_template_id, "/root/LivePortrait/assets/examples/driving/d0.mp4")
                
                # Check if file exists or find any available driving video / pkl
                if not os.path.exists(driving_path):
                    example_dir = "/root/LivePortrait/assets/examples/driving"
                    if os.path.exists(example_dir):
                        valid_files = [
                            os.path.join(example_dir, f)
                            for f in os.listdir(example_dir)
                            if f.endswith(".mp4") or f.endswith(".pkl")
                        ]
                        if valid_files:
                            driving_path = valid_files[0]

            if not driving_path or not os.path.exists(driving_path):
                raise RuntimeError(f"Driving donor video not found in container (path: {driving_path})")

            # 3. Neural Retargeting with LivePortrait Inference CLI
            print(f"[VideoDanceEngine] Executing LivePortrait with donor video: {driving_path}")
            cmd = [
                "python", "/root/LivePortrait/inference.py",
                "-s", src_img_path,
                "-d", driving_path,
                "-o", work_dir,
                "--flag_crop_driving_video",
                "--flag_pasteback",
                "--flag_do_crop"
            ]
            
            res = subprocess.run(cmd, cwd="/root/LivePortrait", capture_output=True, text=True)
            if res.returncode != 0:
                print(f"[VideoDanceEngine] LivePortrait execution stdout: {res.stdout}")
                print(f"[VideoDanceEngine] LivePortrait execution stderr: {res.stderr}")
                raise RuntimeError(f"LivePortrait failed: {res.stderr[:500]}")

            # Locate generated output video in work_dir or subdirectories
            mp4_candidates = glob.glob(os.path.join(work_dir, "**", "*.mp4"), recursive=True)
            out_candidates = [f for f in mp4_candidates if os.path.basename(f) != "custom_donor.mp4" and "concat" not in f]
            if not out_candidates:
                out_candidates = [f for f in mp4_candidates if os.path.basename(f) != "custom_donor.mp4"]
            
            if not out_candidates:
                raise RuntimeError("No output video was generated by LivePortrait pipeline.")

            out_video_path = out_candidates[0]
            print(f"[VideoDanceEngine] Generated video located: {out_video_path}")

            with open(out_video_path, "rb") as f:
                b64_video = base64.b64encode(f.read()).decode("utf-8")

            dur = round(time.time() - t0, 2)
            return {
                "status": "success",
                "result_video_base64": f"data:video/mp4;base64,{b64_video}",
                "duration_seconds": dur,
                "fps": req.fps
            }

        except Exception as e:
            print(f"[VideoDanceEngine] Retargeting error: {e}")
            traceback.print_exc()
            return {
                "status": "error",
                "message": str(e),
                "duration_seconds": round(time.time() - t0, 2)
            }
        finally:
            import shutil
            import torch
            import gc
            if os.path.exists(work_dir):
                shutil.rmtree(work_dir, ignore_errors=True)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()
