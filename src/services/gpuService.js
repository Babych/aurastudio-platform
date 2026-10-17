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
  throw new Error(`GPU cluster temporarily unavailable: ${errors.join(" | ") || "all endpoints unreachable"}`);
}

export async function submitModalTask(asyncEndpoints, payload, authKey = null) {
  let errors = [];
  const reqBody = authKey ? { ...payload, auth_key: authKey } : payload;
  for (const ep of asyncEndpoints) {
    try {
      const res = await fetch(ep.submit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000) // 30s: allows first-request container scaling to accept spawn()
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "queued" || data.task_id) {
          return { ...data, statusEndpoint: ep.status };
        }
      } else {
        const txt = await res.text();
        errors.push(`Status ${res.status}: ${txt.slice(0, 100)}`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`Failed to dispatch task to GPU cluster: ${errors.join(" | ")}`);
}

export async function pollModalTaskStatus(statusEndpoint, taskId, authKey = null) {
  try {
    const authQuery = authKey ? `&auth_key=${encodeURIComponent(authKey)}` : "";
    const url = `${statusEndpoint}?task_id=${encodeURIComponent(taskId)}${authQuery}`;
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      return await res.json();
    }
    return { status: "not_found" };
  } catch (e) {
    return { status: "processing", message: e.message };
  }
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
