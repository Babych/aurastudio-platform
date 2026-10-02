"""
AuraStudio AI Platform - Comprehensive End-to-End Integration Test Suite
Validates Cloudflare Edge Workers, Modal GPU Infrastructure, D1 Database, and Telegram Bot Logic.

Usage:
    python -m pytest tests/test_integration.py -v
    or
    python tests/test_integration.py
"""

import os
import sys
import time
import json
import base64
import unittest
import urllib.request
import urllib.error

PROD_API_URL = os.environ.get("AURASTUDIO_API_URL", "https://aurastudio-ai.memory1024.workers.dev")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "aurastudio-admin-2026")
MODAL_GPU_URL = os.environ.get(
    "MODAL_GPU_URL",
    "https://dmytrobbch--qwen-image-edit-service-qweneditor-api-edit.modal.run"
)

def get_test_portrait_base64() -> str:
    """Load a valid test image from disk or generate a synthetic one."""
    candidate_paths = [
        os.path.join(os.path.dirname(__file__), "..", "web", "assets", "presets", "linkedin.webp"),
        "web/assets/presets/linkedin.webp"
    ]
    for path in candidate_paths:
        if os.path.exists(path):
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")

    # Fallback to in-memory PIL image
    from PIL import Image
    import io
    img = Image.new("RGB", (512, 512), color=(180, 160, 140))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


class TestAuraStudioPlatformIntegration(unittest.TestCase):
    """Production Integration Test Cases."""

    def test_01_stats_endpoint_auth_protection(self):
        """Verify /api/stats is protected and denies access without admin credentials."""
        url = f"{PROD_API_URL}/api/stats"
        print(f"\n[Test 1] Testing Auth Protection on {url}...")

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AuraStudioIntegrationTest/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.assertEqual(resp.status, 401, "Expected HTTP 401 Unauthorized")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 401, f"Expected 401, got {e.code}")
            data = json.loads(e.read().decode("utf-8"))
            self.assertEqual(data.get("status"), "unauthorized")
            print("  [PASS] Unauthorized request correctly rejected with 401.")

    def test_02_stats_endpoint_authorized_schema(self):
        """Verify /api/stats returns accurate live telemetry from D1."""
        url = f"{PROD_API_URL}/api/stats?admin_key={ADMIN_KEY}"
        print(f"\n[Test 2] Querying Authorized Dashboard Metrics: {url}...")

        req = urllib.request.Request(url, headers={"User-Agent": "AuraStudioIntegrationTest/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))

            self.assertEqual(data.get("status"), "success")
            self.assertIn("total_users", data)
            self.assertIn("total_generations", data)
            self.assertIn("recent_tasks", data)
            self.assertIsInstance(data.get("recent_tasks"), list)
            
            print(f"  [PASS] Total Generations: {data.get('total_generations')}, Avg Duration: {data.get('avg_duration')}s")
            print(f"  [PASS] Live Recent Tasks Count: {len(data.get('recent_tasks'))}")

    def test_03_modal_gpu_cluster_direct_inference(self):
        """Directly verify Modal Nvidia L40S GPU inference service."""
        print(f"\n[Test 3] Testing Direct Modal GPU Node: {MODAL_GPU_URL}...")
        test_b64 = get_test_portrait_base64()
        payload = {
            "image_base64": test_b64,
            "prompt": "change clothes to sharp dark navy suit, keep exact same person, 100% exact original face",
            "negative_prompt": "plastic skin, airbrushed, wax, doll, cartoon, blurry",
            "steps": 12,
            "cfg": 1.95,
            "seed": 888424
        }
        
        t0 = time.time()
        req = urllib.request.Request(
            MODAL_GPU_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        
        with urllib.request.urlopen(req, timeout=120) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - t0

            self.assertEqual(data.get("status"), "success", f"Modal GPU returned error: {data.get('message')}")
            self.assertTrue(len(data.get("result_base64", "")) > 10000, "Expected non-empty image result base64")
            print(f"  [PASS] Modal L40S GPU generated image in {elapsed:.2f}s (Output bytes: {len(data['result_base64'])})")

    def test_04_end_to_end_smoke_test_generation(self):
        """Verify full production stack: Cloudflare Edge -> Modal GPU -> D1 Database."""
        url = f"{PROD_API_URL}/api/smoke-test?admin_key={ADMIN_KEY}&preset=linkedin"
        print(f"\n[Test 4] Running Full Stack E2E Generation: {url}...")

        t0 = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": "AuraStudioIntegrationTest/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - t0

            self.assertEqual(data.get("status"), "success", f"E2E test failed: {data}")
            self.assertIn("task_id", data)
            self.assertIn("duration", data)
            self.assertTrue(data.get("output_preview_size", 0) > 10000)

            print(f"  [PASS] E2E Task {data.get('task_id')} completed in {data.get('duration')} (Total HTTP: {elapsed:.2f}s)")
            print(f"  [PASS] Engine: {data.get('gpu_engine')}")


if __name__ == "__main__":
    unittest.main()
