// Service: D1 Database & Persistent Session Management

import { uploadToR2 } from "./gpuService.js";
import { arrayBufferToBase64 } from "../utils/response.js";

// In-memory sessions
export const authSessions = new Map();
export const tgUserSessions = new Map();

// Helper: Check if user has administrative privileges
export function isUserAdmin(userId, username, email, env) {
  if (!userId) return false;
  const adminIds = ["tg_1359272262", "google_112903967526802503571", "test_user"];
  const adminUsernames = ["lame618", "memory1024", "dmytrobbch"];
  const cleanUid = String(userId).toLowerCase();
  const cleanUname = String(username || "").toLowerCase();
  const cleanEmail = String(email || "").toLowerCase();

  if (adminIds.some(id => cleanUid.includes(id.toLowerCase()))) return true;
  if (adminUsernames.some(u => cleanUname === u || cleanUid.includes(u))) return true;
  if (cleanEmail && (cleanEmail.includes("babych") || cleanEmail.includes("memory1024"))) return true;
  if (env && env.ADMIN_USER_IDS && env.ADMIN_USER_IDS.split(",").some(id => cleanUid.includes(id.trim().toLowerCase()))) return true;
  return false;
}

let isTgSessionTableReady = false;
export async function ensureTgSessionTable(env) {
  if (!env || !env.DB || isTgSessionTableReady) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        user_id TEXT PRIMARY KEY,
        last_photo_file_id TEXT,
        pending_action TEXT,
        pending_style TEXT,
        current_task_id TEXT,
        pending_prompt TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    try { await env.DB.prepare(`ALTER TABLE telegram_sessions ADD COLUMN current_task_id TEXT`).run(); } catch(e){}
    try { await env.DB.prepare(`ALTER TABLE telegram_sessions ADD COLUMN pending_prompt TEXT`).run(); } catch(e){}
    isTgSessionTableReady = true;
  } catch (e) {
    console.error("ensureTgSessionTable error:", e);
  }
}

export async function getTgSession(env, userId) {
  if (env && env.DB) {
    try {
      await ensureTgSessionTable(env);
      const row = await env.DB.prepare("SELECT * FROM telegram_sessions WHERE user_id = ?").bind(userId).first();
      if (row) {
        return {
          lastPhotoFileId: row.last_photo_file_id,
          pendingAction: row.pending_action,
          pendingStyle: row.pending_style,
          templateId: row.pending_style,
          presetKey: row.pending_style,
          currentTaskId: row.current_task_id,
          prompt: row.pending_prompt
        };
      }
    } catch(e) {
      console.error("D1 getTgSession error:", e);
    }
  }
  return tgUserSessions.get(userId) || {};
}

export async function setTgSession(env, userId, data) {
  const current = tgUserSessions.get(userId) || {};
  const updated = { ...current, ...data };
  tgUserSessions.set(userId, updated);
  if (env && env.DB) {
    try {
      await ensureTgSessionTable(env);
      const sql = `
        INSERT INTO telegram_sessions (user_id, last_photo_file_id, pending_action, pending_style, current_task_id, pending_prompt, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          last_photo_file_id = COALESCE(excluded.last_photo_file_id, telegram_sessions.last_photo_file_id),
          pending_action = excluded.pending_action,
          pending_style = excluded.pending_style,
          current_task_id = COALESCE(excluded.current_task_id, telegram_sessions.current_task_id),
          pending_prompt = excluded.pending_prompt,
          updated_at = CURRENT_TIMESTAMP
      `;
      const bindParams = [
        userId,
        updated.lastPhotoFileId || updated.last_photo_file_id || null,
        updated.pendingAction || updated.pending_action || null,
        updated.pendingStyle || updated.templateId || updated.presetKey || null,
        updated.currentTaskId || updated.current_task_id || null,
        updated.prompt || updated.pending_prompt || null
      ];
      try {
        await env.DB.prepare(sql).bind(...bindParams).run();
      } catch (colErr) {
        try { await env.DB.prepare(`ALTER TABLE telegram_sessions ADD COLUMN current_task_id TEXT`).run(); } catch(e){}
        try { await env.DB.prepare(`ALTER TABLE telegram_sessions ADD COLUMN pending_prompt TEXT`).run(); } catch(e){}
        await env.DB.prepare(sql).bind(...bindParams).run();
      }
    } catch(e) {
      console.error("D1 setTgSession error:", e);
    }
  }
}

export async function getTgUserPhotoBase64(env, botToken, userId, explicitFileId) {
  const session = await getTgSession(env, userId);
  const photoFileId = explicitFileId || session.lastPhotoFileId;

  if (photoFileId) {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${photoFileId}`);
      const fileData = await fileRes.json();
      if (fileData.ok && fileData.result?.file_path) {
        const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
        const photoBuffer = await photoBlobRes.arrayBuffer();
        const base64 = arrayBufferToBase64(photoBuffer);
        return { base64, taskId: session.currentTaskId, fileId: photoFileId };
      }
    } catch (e) {
      console.error("Error fetching photo from Telegram getFile:", e);
    }
  }

  // Fallback: Check latest generation in D1 for this user
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare(`
        SELECT id, input_image_url FROM generations 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 1
      `).bind(userId).first();

      if (row && row.input_image_url && row.input_image_url !== 'uploaded_image') {
        let b64 = null;
        if (row.input_image_url.startsWith("data:")) {
          b64 = row.input_image_url.replace(/^data:image\/\w+;base64,/, "");
        } else if (row.input_image_url.startsWith("/media/") && env.STORAGE) {
          const obj = await env.STORAGE.get(row.input_image_url.replace("/media/", ""));
          if (obj) {
            const buf = await obj.arrayBuffer();
            b64 = arrayBufferToBase64(buf);
          }
        } else if (row.input_image_url.startsWith("http")) {
          const imgRes = await fetch(row.input_image_url);
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            b64 = arrayBufferToBase64(buf);
          }
        }
        if (b64) {
          return { base64: b64, taskId: row.id, fileId: photoFileId || null };
        }
      }
    } catch (e) {
      console.error("Error fetching photo from D1 fallback:", e);
    }
  }

  return null;
}

export async function recordGenerationInD1(env, { id, userId, source = 'telegram_bot', presetId, prompt, inputBase64, outputBase64, duration, status = 'SUCCESS', errorMessage = null }) {
  if (!env || !env.DB) return;
  try {
    const taskId = id || `tg_gen_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let inThumb = inputBase64 ? (inputBase64.startsWith("data:") ? inputBase64 : `data:image/jpeg;base64,${inputBase64}`) : null;
    let outThumb = outputBase64 ? (outputBase64.startsWith("data:") ? outputBase64 : (outputBase64.startsWith("http") || outputBase64.startsWith("/") ? outputBase64 : `data:image/png;base64,${outputBase64}`)) : null;

    if (env.STORAGE) {
      try {
        if (inThumb && inThumb.startsWith("data:")) {
          const r2In = await uploadToR2(env.STORAGE, `in_${taskId}.jpg`, inThumb);
          if (r2In) inThumb = r2In;
        }
        if (outThumb && outThumb.startsWith("data:")) {
          const isVideo = outThumb.includes("video") || (presetId && presetId.includes("dance"));
          const ext = isVideo ? ".mp4" : ".png";
          const r2Out = await uploadToR2(env.STORAGE, `out_${taskId}${ext}`, outThumb);
          if (r2Out) outThumb = r2Out;
        }
      } catch (r2Err) {
        console.error("R2 storage error in recordGenerationInD1:", r2Err);
      }
    }

    const parsedDur = parseFloat(duration);
    const durSec = (!isNaN(parsedDur) && parsedDur > 0) ? parsedDur : null;

    await env.DB.prepare(`
      INSERT INTO generations (id, user_id, source, preset_id, prompt, input_image_url, output_image_url, status, duration_seconds, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        preset_id = excluded.preset_id,
        prompt = excluded.prompt,
        input_image_url = CASE WHEN excluded.input_image_url IS NOT NULL AND excluded.input_image_url != 'uploaded_image' THEN excluded.input_image_url ELSE generations.input_image_url END,
        output_image_url = COALESCE(excluded.output_image_url, generations.output_image_url),
        status = excluded.status,
        duration_seconds = excluded.duration_seconds,
        error_message = excluded.error_message
    `).bind(
      taskId,
      userId || "anonymous",
      source,
      presetId || "custom",
      (prompt || "").slice(0, 500),
      inThumb || "uploaded_image",
      outThumb || (status === 'SUCCESS' ? "generated_image" : null),
      status,
      durSec,
      errorMessage || null
    ).run();

    if (status === 'SUCCESS' || status === 'FAILED') {
      await env.DB.prepare(`
        INSERT INTO telemetry_events (event_type, source, user_id, duration_seconds, usd_amount, details)
        VALUES (?, ?, ?, ?, 0.0, ?)
      `).bind(
        status === 'SUCCESS' ? 'GENERATION_SUCCESS' : 'GENERATION_FAILURE',
        source,
        userId || "anonymous",
        durSec,
        JSON.stringify({ preset: presetId, prompt: (prompt || "").slice(0, 100), task_id: taskId, error: errorMessage })
      ).run();

      if (userId && status === 'SUCCESS') {
        await env.DB.prepare(`
          UPDATE users SET total_generations = COALESCE(total_generations, 0) + 1 WHERE id = ?
        `).bind(userId).run();
      }
    }
    return taskId;
  } catch (err) {
    console.error("recordGenerationInD1 error:", err);
    try {
      if (env && env.DB) {
        await env.DB.prepare(`
          INSERT INTO error_logs (context, error_message, details)
          VALUES ('record_generation_d1', ?, ?)
        `).bind(err.message, err.stack || null).run();
      }
    } catch(e) {}
  }
}
