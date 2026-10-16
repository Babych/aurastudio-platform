import os
import sys
import time
import json
import base64
import urllib.request
import urllib.error

MODAL_ENDPOINTS = [
    "https://memory1024--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run",
    "https://memory1024--qwen-image-edit-service-qweneditor-api-edit.modal.run"
]

INPUT_IMAGE_PATH = os.path.join(os.path.dirname(__file__), "..", "web", "assets", "presets", "linkedin.jpg")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)
OUTPUT_IMAGE_PATH = os.path.join(OUTPUT_DIR, "iteration_skin_subsurface.png")

def run_test():
    print(f"[*] Reading test portrait from: {INPUT_IMAGE_PATH}")
    if not os.path.exists(INPUT_IMAGE_PATH):
        raise FileNotFoundError(f"Input image not found: {INPUT_IMAGE_PATH}")

    with open(INPUT_IMAGE_PATH, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("utf-8")

    # Formula designed for living, translucent skin WITHOUT dots or plastic
    positive_prompt = (
        "change clothes to an elegant beige cashmere sweater, authentic candid portrait photography, "
        "natural soft diffused studio lighting, gentle realistic subsurface scattering, delicate skin translucency, "
        "soft natural skin contours, matching warm skin tone, shallow depth of field, 85mm portrait lens, f/1.8, "
        "razor-sharp focused eyes and gaze, keep exact same person, 100% exact original face, "
        "preserve full original framing, no cropping, no zoom-in, seamless photorealistic integration, no text"
    )

    negative_prompt = (
        "plastic skin, airbrushed, wax, doll, mannequin, barbie, cartoon, 3d render, CGI, "
        "over-smoothed skin, filtered look, porcelain, waxy surface, black dots, stippling, "
        "pepper noise, harsh pores, freckle dots, dirty skin, acne dots, grainy skin, "
        "blurry, noisy, distorted eyes, extra fingers, text, watermark, deformed anatomy, "
        "bad proportions, bad lighting, changed face, altered eyes, different identity, cropped, zoomed in"
    )

    payload = {
        "image_base64": img_b64,
        "prompt": positive_prompt,
        "negative_prompt": negative_prompt,
        "steps": 22,
        "cfg": 1.95,
        "seed": 888424
    }

    print("[*] Sending request directly to Modal GPU cluster (bypassing production)...")
    print(f"[*] Prompt: {positive_prompt[:90]}...")
    t0 = time.time()

    data = None
    last_err = ""
    for ep in MODAL_ENDPOINTS:
        try:
            print(f"[*] Trying endpoint: {ep}")
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
        except Exception as e:
            last_err = str(e)
            print(f"[-] Endpoint {ep} failed: {e}")

    if not data or not data.get("result_base64"):
        raise RuntimeError(f"All Modal endpoints failed. Last error: {last_err}")

    dur = round(time.time() - t0, 1)
    res_b64 = data["result_base64"]
    if "base64," in res_b64:
        res_b64 = res_b64.split("base64,")[1]

    with open(OUTPUT_IMAGE_PATH, "wb") as f:
        f.write(base64.b64decode(res_b64))

    file_size_kb = round(os.path.getsize(OUTPUT_IMAGE_PATH) / 1024, 1)
    print(f"\n[+] SUCCESS in {dur}s!")
    print(f"[+] Output image saved to: {OUTPUT_IMAGE_PATH} ({file_size_kb} KB)")
    return OUTPUT_IMAGE_PATH

if __name__ == "__main__":
    run_test()
