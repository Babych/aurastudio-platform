// GPU Communication & Modal Load Balancing Service

export async function callModalWithFallback(endpoints, payload) {
  let errors = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(240000) // 240s max: allows cold start + ComfyUI + Q6_K weights mounting to finish safely in background
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "success") {
          return data;
        }
        errors.push(data.message || "Model failed to process");
      } else {
        const txt = await res.text();
        errors.push(`GPU status ${res.status}: ${txt.slice(0, 100)}`);
      }
    } catch (e) {
      errors.push(e.name === "TimeoutError" ? "GPU cold start timed out (>240s)" : e.message);
    }
  }
  throw new Error(`GPU cluster temporarily unavailable. Please retry in a few moments.`);
}

export async function uploadToR2(bucket, key, base64Data) {
  if (!bucket) return null;
  const b64 = base64Data.replace(/^data:(image|video)\/\w+;base64,/, "");
  const byteString = atob(b64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }
  
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: key.endsWith('.mp4') ? 'video/mp4' : (key.endsWith('.png') ? 'image/png' : 'image/jpeg')
    }
  });
  return `/media/${key}`;
}
