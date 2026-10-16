// GPU Communication & Modal Load Balancing Service

export async function callModalWithFallback(endpoints, payload) {
  let errors = [];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "success") {
          return data;
        }
        errors.push(`${ep}: ${data.message || "Model failed to process"}`);
      } else {
        const txt = await res.text();
        errors.push(`${ep} (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      errors.push(`${ep}: ${e.message}`);
    }
  }
  throw new Error(`All Modal GPU endpoints failed. Errors: ${errors.join(" | ")}`);
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
