import { CORS_HEADERS } from "../config/constants.js";

// Helper: JSON response with CORS
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}

// Helper: Safe Base64 encoder for large ArrayBuffers (prevents stack overflow)
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// Helper: Log critical errors to D1
export async function logCriticalError(env, ctx, context, errorMsg, userId = null, details = null) {
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO error_logs (context, error_message, user_id, details)
        VALUES (?, ?, ?, ?)
      `).bind(context, (errorMsg || "").slice(0, 1000), userId, details ? JSON.stringify(details) : null).run();
    } catch (e) {
      console.error("Failed to write to error_logs:", e);
    }
  }
}
