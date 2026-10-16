"""
Local Multi-Iteration Skin Quality & Framing Calibration Harness
Sends requests directly to Modal GPU cluster to evaluate visual skin quality and framing without affecting production.
"""

import os
import sys
import time
import json
import base64
import argparse
import urllib.request
import urllib.error

MODAL_ENDPOINTS = [
    "https://memory1024--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run",
    "https://memory1024--qwen-image-edit-service-qweneditor-api-edit.modal.run"
]

INPUT_IMAGE_PATH = os.path.join(os.path.dirname(__file__), "..", "web", "assets", "presets", "linkedin.jpg")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def run_iteration(iteration_num: int, prompt: str, negative_prompt: str, cfg: float = 1.85, steps: int = 22, seed: int = 888424):
    out_file = os.path.join(OUTPUT_DIR, f"iteration_{iteration_num}.png")
    print(f"\n=======================================================")
    print(f"[*] Starting Iteration {iteration_num}")
    print(f"[*] Input: {INPUT_IMAGE_PATH}")
    print(f"[*] CFG: {cfg}, Steps: {steps}, Seed: {seed}")
    print(f"[*] Positive Prompt: {prompt}")
    print(f"[*] Negative Prompt: {negative_prompt}")
    print(f"=======================================================\n")

    with open(INPUT_IMAGE_PATH, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("utf-8")

    payload = {
        "image_base64": img_b64,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "steps": steps,
        "cfg": cfg,
        "seed": seed
    }

    t0 = time.time()
    data = None
    last_err = ""

    for ep in MODAL_ENDPOINTS:
        try:
            print(f"[*] Dispatching to Modal endpoint: {ep}")
            req = urllib.request.Request(
                ep,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    if data.get("status") == "success":
                        break
                    else:
                        last_err = data.get("message", "Unknown error")
                        print(f"[-] Model returned non-success: {last_err}")
        except Exception as e:
            last_err = str(e)
            print(f"[-] Endpoint {ep} failed: {e}")

    if not data or not data.get("result_base64"):
        raise RuntimeError(f"All Modal endpoints failed. Last error: {last_err}")

    dur = round(time.time() - t0, 1)
    res_b64 = data["result_base64"]
    if "base64," in res_b64:
        res_b64 = res_b64.split("base64,")[1]

    with open(out_file, "wb") as f:
        f.write(base64.b64decode(res_b64))

    file_size_kb = round(os.path.getsize(out_file) / 1024, 1)
    print(f"\n[+] Iteration {iteration_num} SUCCESS in {dur}s!")
    print(f"[+] Output image saved to: {out_file} ({file_size_kb} KB)")
    return out_file

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--iter", type=int, default=1, help="Iteration number (1, 2, or 3)")
    parser.add_argument("--cfg", type=float, default=1.85, help="Guidance scale")
    parser.add_argument("--steps", type=int, default=22, help="Inference steps")
    args = parser.parse_args()

    if args.iter == 1:
        # Iteration 1: Anti-Zoom & Anti-Wax Fine Organic Skin Formula
        pos = (
            "change clothes to an elegant beige cashmere sweater, keep exact same person, 100% exact original face, "
            "preserve full original framing, medium shot showing torso, same camera distance, no cropping, no zoom-in, "
            "natural soft directional studio lighting from upper left, fine organic skin texture, natural skin sheen, "
            "subtle realistic facial expression lines, matching original warm skin tone, sharp focused eyes and gaze, "
            "exact original lips and expression, seamless photorealistic integration, no text"
        )
        neg = (
            "close-up crop, zoomed in, headshot, bust crop, macro zoom, plastic skin, airbrushed, wax, doll, cartoon, "
            "3d render, blurry, distorted eyes, neck smudges, black dots, stippling, pepper noise, extra fingers, "
            "text, watermark, deformed anatomy, bad lighting, changed face, altered eyes, different identity"
        )
        run_iteration(1, pos, neg, cfg=args.cfg, steps=args.steps)

    elif args.iter == 2:
        # Iteration 2: Realistic Cashmere Weave & Catchlight Specular Lighting
        pos = (
            "change clothes to a finely woven luxury oatmeal cashmere crewneck knit sweater with authentic soft fabric texture and natural drape, "
            "keep exact same person, 100% exact original face, preserve full original framing, medium shot showing torso down to hands, "
            "exact same camera distance, no cropping, no zoom-in, natural key studio lighting from upper left with subtle rim light, "
            "delicate specular highlights on cheekbones, fine authentic skin texture with natural skin translucency, "
            "subtle natural smile lines, matching original warm skin tone, sharp focused eyes with clear catchlights, "
            "exact original lips and expression, seamless photorealistic integration, raw 35mm dslr photograph, no text"
        )
        neg = (
            "close-up crop, zoomed in, headshot, bust crop, macro zoom, embossed pattern, maze pattern on clothes, flat sweater, "
            "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, distorted eyes, neck smudges, black dots, "
            "stippling, pepper noise, extra fingers, text, watermark, deformed anatomy, bad lighting, changed face, altered eyes, different identity"
        )
        run_iteration(2, pos, neg, cfg=args.cfg or 1.90, steps=args.steps)

    elif args.iter == 3:
        # Iteration 3: Ultra-Sharp Editorial Standard (Charcoal Merino, Optical Skin Pores, Zero Zoom)
        pos = (
            "change clothes to a finely tailored dark charcoal grey merino wool crewneck sweater with crisp ribbed collar and cuffs, "
            "keep exact same person, 100% exact original face, preserve full original framing, medium shot showing torso down to hands, "
            "exact same camera distance, no cropping, no zoom-in, professional studio key lighting from upper left, "
            "subtle specular highlights on cheeks, authentic natural micro skin pores, gentle subsurface scattering, "
            "natural warm skin tone, clean jawline and neck, razor-sharp focused eyes with natural catchlights, "
            "exact original lips and expression, raw 35mm dslr portrait photography, sharp focus, seamless photorealistic integration, no text"
        )
        neg = (
            "close-up crop, zoomed in, headshot, bust crop, macro zoom, plastic skin, airbrushed, wax, doll, cartoon, 3d render, "
            "blurry, painterly, soft focus, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts, "
            "extra fingers, text, watermark, deformed anatomy, bad lighting, changed face, altered eyes, different identity"
        )
        run_iteration(3, pos, neg, cfg=args.cfg or 1.95, steps=args.steps or 24)
