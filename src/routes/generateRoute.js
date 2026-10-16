// Route Handler: AI Generation, Queue Status, Task Status & Share Creation

import { 
  DAILY_FREE_GENERATIONS_LIMIT, 
  DEFAULT_BLANK_CANVAS_BASE64, 
  MODAL_PHOTO_ENDPOINTS, 
  anchorPromptForPhoto 
} from "../config/constants.js";
import { jsonResponse, logCriticalError } from "../utils/response.js";
import { callModalWithFallback, uploadToR2 } from "../services/gpuService.js";
import { getLiveQueueStatus, getTaskStatus } from "../services/queueService.js";
import { isUserAdmin } from "../services/dbService.js";

export async function handleQueueStatus(request, env, url) {
  const statusData = await getLiveQueueStatus(env);
  return jsonResponse(statusData);
}

export async function handleTaskStatus(request, env, url) {
  const tid = url.pathname.replace(/^\/api\/task-status\//, "").split("/")[0].trim();
  if (!tid) return jsonResponse({ status: "error", message: "Task ID required" }, 400);
  const taskData = await getTaskStatus(env, tid, url.origin);
  const httpStatus = taskData.status === "not_found" ? 404 : 200;
  return jsonResponse(taskData, httpStatus);
}

export async function handleShareCreate(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const { task_id } = body;
    if (!task_id) return jsonResponse({ status: "error", message: "Missing task_id" }, 400);

    const shareToken = `s_${task_id.replace('task_', '')}`;
    if (env.DB) {
      await env.DB.prepare("UPDATE generations SET is_shared = 1, share_token = ? WHERE id = ?").bind(shareToken, task_id).run();
    }

    const shareUrl = `${url.origin}/s/${shareToken}`;
    return jsonResponse({
      status: "success",
      share_token: shareToken,
      share_url: shareUrl
    });
  } catch(e) {
    return jsonResponse({ status: "error", message: e.message }, 500);
  }
}

export async function handleGenerate(request, env, ctx, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let currentTaskId = null;
  try {
    const body = await request.json();
    const { image_base64, prompt, preset_id, user_id, user_email, user_name, task_id } = body;
    currentTaskId = task_id || null;

    // Guest / Anonymous User handling: Allow 1 Free Trial Generation without login!
    const isGuest = !user_id || user_id === "anonymous" || user_id === "anonymous_web" || user_id.startsWith("guest_");
    const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("x-real-ip") || "unknown_ip";
    const effectiveUserId = isGuest ? (user_id && user_id.startsWith("guest_") ? user_id : `guest_${clientIp.replace(/[^a-zA-Z0-9]/g, "_")}`) : user_id;

    if (isGuest && env.DB) {
      // Check if this guest (or IP) has already used their 1 free generation without login
      const guestGenCount = await env.DB.prepare(`
        SELECT COUNT(*) as count 
        FROM generations 
        WHERE (user_id = ? OR user_id LIKE ?) AND status = 'SUCCESS'
      `).bind(effectiveUserId, `%${clientIp.replace(/[^a-zA-Z0-9]/g, "_")}%`).first();

      const guestUsed = (guestGenCount && guestGenCount.count) || 0;
      if (guestUsed >= 1) {
        return jsonResponse({
          status: "auth_required",
          message: `Ви вже використали 1 пробну генерацію без входу. Будь ласка, увійдіть через Google або Telegram, щоб розблокувати 5 щоденних безкоштовних генерацій!`
        }, 401);
      }
    }

    // Check 24-hour daily quota & Telegram Stars balance in D1 (Admins exempt)
    const isAdmin = isUserAdmin(user_id, user_name, user_email, env);
    let dailyUsed = 0;
    if (env.DB && !isAdmin) {
      const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(user_id).first();
      const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user_id).first();

      const dailyCountRow = await env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM generations 
        WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
      `).bind(user_id).first();

      dailyUsed = (dailyCountRow && dailyCountRow.count) || 0;

      if (dailyUsed >= DAILY_FREE_GENERATIONS_LIMIT) {
        if (sub) {
          // Active subscription - allowed
        } else if (u && (u.stars_balance || 0) >= 10) {
          // Deduct 10 Telegram Stars from user balance
          await env.DB.prepare("UPDATE users SET stars_balance = stars_balance - 10 WHERE id = ?").bind(user_id).run();
        } else {
          const fifthGen = await env.DB.prepare(`
            SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
            FROM generations
            WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
            ORDER BY created_at DESC
            LIMIT 1 OFFSET ?
          `).bind(user_id, DAILY_FREE_GENERATIONS_LIMIT - 1).first();

          const hoursLeft = fifthGen ? Math.max(1, Math.ceil((86400 - fifthGen.seconds_ago) / 3600)) : 24;
          return jsonResponse({
            status: "daily_limit_reached",
            daily_limit: DAILY_FREE_GENERATIONS_LIMIT,
            hours_left: hoursLeft,
            stars_balance: (u && u.stars_balance) || 0,
            required_stars: 10,
            message: `Ваш щоденний безкоштовний ліміт (${DAILY_FREE_GENERATIONS_LIMIT} генерацій) вичерпано. Поповніть баланс Telegram Stars (⭐️ 10) або зачекайте ${hoursLeft} год.`
          }, 403);
        }
      }
    }

    const taskId = task_id || `task_${Date.now().toString().slice(-6)}_${Math.random().toString(36).substring(2, 6)}`;
    currentTaskId = taskId;
    const shareToken = taskId.replace('task_', 's_');

    const isTextToImage = !image_base64 || image_base64 === "empty" || (typeof image_base64 === "string" && image_base64.trim() === "");
    const effectiveInputBase64 = isTextToImage
      ? DEFAULT_BLANK_CANVAS_BASE64
      : image_base64.replace(/^data:image\/\w+;base64,/, "");

    const finalPrompt = isTextToImage
      ? `candid 8k dslr photograph, ultra-detailed, cinematic soft lighting, realistic depth of field, photorealistic, ${prompt}`
      : anchorPromptForPhoto(prompt);

    const cleanNeg = isTextToImage
      ? "blurry, low quality, distorted, bad anatomy, artifacts, malformed, deformed, text, watermark"
      : "cropped, close-up crop, zoomed in, out of frame, cut off face, macro zoom, plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, painterly, soft focus, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts, extra fingers, text, watermark, deformed anatomy, bad proportions, bad lighting, changed face, altered eyes, different identity";

    const payload = {
      image_base64: effectiveInputBase64,
      prompt: finalPrompt,
      negative_prompt: cleanNeg,
      steps: 22,
      cfg: 1.95,
      seed: 888424
    };

    // Register initial PROCESSING state in D1 for window-close & reload recovery
    if (env.DB) {
      const inThumbEarly = isTextToImage ? null : (image_base64.startsWith("data:") ? image_base64 : `data:image/jpeg;base64,${image_base64}`);
      try {
        await env.DB.prepare(`
          INSERT INTO generations (id, user_id, source, preset_id, prompt, input_image_url, status, duration_seconds, is_shared, share_token)
          VALUES (?, ?, 'web', ?, ?, ?, 'PROCESSING', 0, 1, ?)
          ON CONFLICT(id) DO UPDATE SET status = 'PROCESSING'
        `).bind(
          taskId,
          effectiveUserId,
          preset_id || (isTextToImage ? "text_to_image" : "custom"),
          prompt.slice(0, 500),
          inThumbEarly,
          shareToken
        ).run();
      } catch (e) {
        console.error("D1 initial task registration error:", e);
      }
    }

    const t0 = Date.now();
    const modalData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, payload);

    if (!modalData || !modalData.result_base64) {
      throw new Error(modalData.message || "Model failed to return edited image");
    }

    let dur = modalData.duration_seconds || ((Date.now() - t0) / 1000).toFixed(1);
    let resultDataUri = modalData.result_base64.startsWith("data:")
      ? modalData.result_base64
      : `data:image/png;base64,${modalData.result_base64}`;

    // Async D1 Journaling
    if (env.DB) {
      ctx.waitUntil((async () => {
        try {
          await env.DB.prepare(`
            UPDATE users 
            SET free_generations_used = free_generations_used + 1,
                total_generations = total_generations + 1
            WHERE id = ?
          `).bind(user_id).run();

          let inThumb = isTextToImage ? null : (image_base64.startsWith("data:") ? image_base64 : `data:image/jpeg;base64,${image_base64}`);
          let outThumb = resultDataUri;

          // Save to R2 if available
          if (env.STORAGE) {
            const inExt = inThumb && inThumb.includes("image/png") ? ".png" : ".jpg";
            const outExt = outThumb.includes("image/png") ? ".png" : ".jpg";
            
            const r2InUrl = inThumb ? await uploadToR2(env.STORAGE, `in_${taskId}${inExt}`, inThumb) : null;
            const r2OutUrl = await uploadToR2(env.STORAGE, `out_${taskId}${outExt}`, outThumb);
            
            if (r2InUrl) inThumb = url.origin + r2InUrl;
            if (r2OutUrl) outThumb = url.origin + r2OutUrl;
            
            resultDataUri = outThumb;
          }

          await env.DB.prepare(`
            INSERT INTO generations (id, user_id, source, preset_id, prompt, input_image_url, output_image_url, status, duration_seconds, is_shared, share_token)
            VALUES (?, ?, 'web', ?, ?, ?, ?, 'SUCCESS', ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              output_image_url = excluded.output_image_url,
              status = 'SUCCESS',
              duration_seconds = excluded.duration_seconds
          `).bind(
            taskId,
            effectiveUserId,
            preset_id || (isTextToImage ? "text_to_image" : "custom"),
            prompt.slice(0, 500),
            inThumb,
            outThumb,
            parseFloat(dur),
            shareToken
          ).run();

          await env.DB.prepare(`
            INSERT INTO telemetry_events (event_type, source, user_id, duration_seconds, usd_amount, details)
            VALUES ('GENERATION_SUCCESS', 'web', ?, ?, 0.0, ?)
          `).bind(
            effectiveUserId,
            parseFloat(dur),
            JSON.stringify({ preset: preset_id, prompt: prompt.slice(0, 100), share_token: shareToken })
          ).run();
        } catch (e) {
          console.error("D1 async journaling error:", e);
        }
      })());
    }

    const origin = url.origin;
    const shareUrl = `${origin}/s/${shareToken}`;
    const twitterText = encodeURIComponent("Check out my AI photo created with @AuraStudioAi! 🚀✨ Try 5 free transformations daily:");
    const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${twitterText}&url=${encodeURIComponent(shareUrl)}`;

    return jsonResponse({
      status: "success",
      task_id: taskId,
      mode: isTextToImage ? "text_to_image" : "image_to_image",
      share_token: shareToken,
      share_url: shareUrl,
      twitter_intent_url: twitterIntentUrl,
      duration_seconds: parseFloat(dur),
      result_base64: resultDataUri,
      daily_limit: DAILY_FREE_GENERATIONS_LIMIT,
      free_remaining: isAdmin ? 999 : Math.max(0, DAILY_FREE_GENERATIONS_LIMIT - (dailyUsed + 1))
    });
  } catch (err) {
    if (env.DB && currentTaskId) {
      ctx.waitUntil(env.DB.prepare("UPDATE generations SET status = 'FAILED', error_message = ? WHERE id = ?").bind(err.message, currentTaskId).run().catch(() => {}));
    }
    logCriticalError(env, ctx, "modal_photo_gpu", err.message, null);
    return jsonResponse({ status: "error", message: err.message }, 500);
  }
}
