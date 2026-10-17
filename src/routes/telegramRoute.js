// Route Handler: Telegram Bot Webhook, Interactive Menus, Sessions & Debug Telemetry

import { jsonResponse, logCriticalError, arrayBufferToBase64 } from "../utils/response.js";
import { 
  DAILY_FREE_GENERATIONS_LIMIT, 
  DEFAULT_BLANK_CANVAS_BASE64, 
  GLOBAL_PRESETS, 
  MODAL_PHOTO_ENDPOINTS, 
  anchorPromptForPhoto 
} from "../config/constants.js";
import { callModalWithFallback } from "../services/gpuService.js";
import { 
  authSessions, 
  isUserAdmin, 
  getTgSession, 
  setTgSession, 
  getTgUserPhotoBase64, 
  recordGenerationInD1 
} from "../services/dbService.js";

// Top-level Telegram Helpers
export async function sendTgMessageHelper(botToken, chatId, text, extra = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...extra })
    });
    const data = await res.json();
    if (!data.ok && data.description && data.description.includes("can't parse entities")) {
      return await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`\[\]]/g, ""), ...extra })
      });
    }
    return data;
  } catch(e) {
    console.error("sendTgMessage error:", e);
    throw e;
  }
}

export async function sendTgPhotoHelper(botToken, chatId, photoUrlOrBase64, caption, extra = {}) {
  try {
    let res, data;
    const isBase64 = photoUrlOrBase64.startsWith("data:") || (!photoUrlOrBase64.startsWith("http") && photoUrlOrBase64.length > 500);
    if (isBase64) {
      const base64Data = photoUrlOrBase64.replace(/^data:image\/\w+;base64,/, "").replace(/\s/g, "");
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      
      const formData = new FormData();
      formData.append("chat_id", chatId.toString());
      formData.append("caption", caption);
      formData.append("parse_mode", "Markdown");
      formData.append("photo", new Blob([bytes], { type: "image/png" }), "result.png");
      if (extra.reply_markup) formData.append("reply_markup", JSON.stringify(extra.reply_markup));

      res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        body: formData
      });
      data = await res.json();
      if (!data.ok) {
        const fd2 = new FormData();
        fd2.append("chat_id", chatId.toString());
        fd2.append("caption", caption.replace(/[*_`\[\]]/g, ""));
        fd2.append("photo", new Blob([bytes], { type: "image/png" }), "result.png");
        if (extra.reply_markup) fd2.append("reply_markup", JSON.stringify(extra.reply_markup));
        res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          body: fd2
        });
        data = await res.json();
      }
    } else {
      res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: photoUrlOrBase64, caption, parse_mode: "Markdown", ...extra })
      });
      data = await res.json();
      if (!data.ok) {
        res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, photo: photoUrlOrBase64, caption: caption.replace(/[*_`\[\]]/g, ""), ...extra })
        });
        data = await res.json();
      }
    }
    if (!data.ok) {
      throw new Error(`Telegram sendPhoto failed: ${data.description || "Unknown error"}`);
    }
    return data;
  } catch (e) {
    console.error("sendTgPhoto error:", e);
    throw e;
  }
}

export async function sendTgVideoHelper(botToken, chatId, videoUrlOrBase64, caption, extra = {}) {
  try {
    let res, data;
    if (videoUrlOrBase64.startsWith("data:") || !videoUrlOrBase64.startsWith("http")) {
      const base64Data = videoUrlOrBase64.replace(/^data:video\/\w+;base64,/, "").replace(/\s/g, "");
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      
      const formData = new FormData();
      formData.append("chat_id", chatId.toString());
      formData.append("caption", caption);
      formData.append("parse_mode", "Markdown");
      formData.append("video", new Blob([bytes], { type: "video/mp4" }), "output.mp4");
      if (extra.reply_markup) formData.append("reply_markup", JSON.stringify(extra.reply_markup));

      res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
        method: "POST",
        body: formData
      });
      data = await res.json();
      if (!data.ok) {
        const fd2 = new FormData();
        fd2.append("chat_id", chatId.toString());
        fd2.append("caption", caption.replace(/[*_`\[\]]/g, ""));
        fd2.append("video", new Blob([bytes], { type: "video/mp4" }), "output.mp4");
        if (extra.reply_markup) fd2.append("reply_markup", JSON.stringify(extra.reply_markup));
        res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
          method: "POST",
          body: fd2
        });
        data = await res.json();
      }
    } else {
      res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, video: videoUrlOrBase64, caption, parse_mode: "Markdown", ...extra })
      });
      data = await res.json();
      if (!data.ok) {
        res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, video: videoUrlOrBase64, caption: caption.replace(/[*_`\[\]]/g, ""), ...extra })
        });
        data = await res.json();
      }
    }
    if (!data.ok) {
      throw new Error(`Telegram sendVideo failed: ${data.description || "Unknown error"}`);
    }
    return data;
  } catch (e) {
    console.error("sendTgVideo error:", e);
    throw e;
  }
}

export async function sendTgChatActionHelper(botToken, chatId, action = "upload_photo") {
  try {
    return await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action })
    });
  } catch(e) {}
}

export async function handleTelegramDebug(request, env, url) {
  const adminKey = url.searchParams.get("admin_key") || request.headers.get("X-Admin-Key");
  const configuredKey = env.ADMIN_SECRET_KEY || env.ADMIN_SECRET;
  if (!configuredKey || !adminKey || adminKey !== configuredKey) {
    return jsonResponse({ status: "error", message: "Unauthorized. Valid admin_key required." }, 401);
  }

  const botToken = env.AURA_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  let tgMe = null;
  let tgWebhookInfo = null;
  let webhookActionResult = null;

  if (botToken) {
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      tgMe = await meRes.json();
    } catch (e) {
      tgMe = { error: e.message };
    }

    try {
      const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
      tgWebhookInfo = await whRes.json();
    } catch (e) {
      tgWebhookInfo = { error: e.message };
    }

    const action = url.searchParams.get("action");
    if (action === "set_webhook") {
      try {
        const setRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://aurastudio-ai.memory1024.workers.dev/api/telegram-webhook",
            allowed_updates: ["message", "callback_query", "pre_checkout_query"],
            drop_pending_updates: url.searchParams.get("drop_pending") === "true"
          })
        });
        webhookActionResult = await setRes.json();
      } catch (e) {
        webhookActionResult = { error: e.message };
      }
    }

    if (action === "test_send_photo") {
      const testChatId = url.searchParams.get("chat_id") || "1359272262";
      const resPhoto = await getTgUserPhotoBase64(env, botToken, `tg_${testChatId}`, null);
      const photoPayload = resPhoto?.base64 || "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      try {
        const sendRes = await sendTgPhotoHelper(botToken, testChatId, photoPayload, "🧪 *AuraStudio AI — Тестова доставка результату*\n\nЗ'єднання з Telegram API працює бездоганно! ✨");
        return jsonResponse({ status: "success", telegram_response: sendRes });
      } catch(e) {
        return jsonResponse({ status: "error", error: e.message }, 500);
      }
    }

    if (action === "test_resolve") {
      const testUserId = url.searchParams.get("user_id") || "tg_1359272262";
      const resPhoto = await getTgUserPhotoBase64(env, botToken, testUserId, null);
      return jsonResponse({
        status: "success",
        user_id: testUserId,
        found: !!resPhoto,
        taskId: resPhoto?.taskId,
        fileId: resPhoto?.fileId,
        base64_length: resPhoto?.base64?.length
      });
    }

    if (action === "test_generate") {
      const testUserId = url.searchParams.get("user_id") || "tg_1359272262";
      const presetKey = url.searchParams.get("preset") || "linkedin";
      const resPhoto = await getTgUserPhotoBase64(env, botToken, testUserId, null);
      if (!resPhoto || !resPhoto.base64) {
        return jsonResponse({ status: "error", message: "No photo found for user", testUserId }, 400);
      }
      const prompt = anchorPromptForPhoto(GLOBAL_PRESETS[presetKey] || "enhance photo to studio magazine portrait");
      const startTime = Date.now();
      const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
        image_base64: resPhoto.base64,
        prompt,
        negative_prompt: "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, painterly, soft focus, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts, extra fingers, text, watermark, deformed anatomy, bad proportions, bad lighting, changed face, altered eyes, different identity",
        steps: 22,
        cfg: 1.95,
        seed: 888424
      });
      const dur = ((Date.now() - startTime) / 1000).toFixed(1);
      const taskId = resPhoto.taskId || `tg_gen_${Date.now()}`;
      await recordGenerationInD1(env, {
        id: taskId,
        userId: testUserId,
        source: "telegram_bot",
        presetId: presetKey,
        prompt,
        inputBase64: resPhoto.base64,
        outputBase64: mData.result_base64,
        duration: dur,
        status: "SUCCESS"
      });
      return jsonResponse({
        status: "success",
        duration: `${dur}s`,
        taskId,
        result_base64_length: mData.result_base64?.length
      });
    }
  }

  let recentGenerations = [];
  let recentErrors = [];
  let recentSessions = [];
  if (env.DB) {
    try {
      const gRes = await env.DB.prepare(`
        SELECT id, user_id, source, preset_id, prompt, status, duration_seconds, error_message, created_at
        FROM generations ORDER BY rowid DESC LIMIT 10
      `).all();
      recentGenerations = gRes.results || [];
    } catch(e) { recentGenerations = [{ error: e.message }]; }

    try {
      const eRes = await env.DB.prepare(`
        SELECT id, context, error_message, user_id, details, created_at
        FROM error_logs ORDER BY rowid DESC LIMIT 10
      `).all();
      recentErrors = eRes.results || [];
    } catch(e) { recentErrors = [{ error: e.message }]; }

    try {
      const sRes = await env.DB.prepare(`
        SELECT * FROM telegram_sessions ORDER BY rowid DESC LIMIT 10
      `).all();
      recentSessions = sRes.results || [];
    } catch(e) { recentSessions = [{ error: e.message }]; }
  }

  return jsonResponse({
    status: "success",
    timestamp: new Date().toISOString(),
    bot_token_present: !!botToken,
    telegram_me: tgMe,
    telegram_webhook_info: tgWebhookInfo,
    webhook_action_result: webhookActionResult,
    recent_generations: recentGenerations,
    recent_sessions: recentSessions,
    recent_errors: recentErrors
  });
}

export async function handleTelegramWebhook(request, env, ctx, url) {
  try {
    const update = await request.json();
    const botToken = env.AURA_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("Bot token secret not configured");

    const sendTgMessage = (cId, txt, extra = {}) => sendTgMessageHelper(botToken, cId, txt, extra);
    const sendTgPhoto = (cId, p, cap, extra = {}) => sendTgPhotoHelper(botToken, cId, p, cap, extra);
    const sendTgVideo = (cId, v, cap, extra = {}) => sendTgVideoHelper(botToken, cId, v, cap, extra);
    const sendTgChatAction = (cId, act = "upload_photo") => sendTgChatActionHelper(botToken, cId, act);

    // 1. Handle Telegram Stars Pre-Checkout Query
    if (update.pre_checkout_query) {
      await fetch(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true
        })
      });
      return jsonResponse({ ok: true });
    }

    // 2. Handle Callback Queries
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id || cb.from?.id;
      const user = cb.from || {};
      const userId = `tg_${user.id || cb.message?.chat?.id}`;
      const data = cb.data || "";

      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id })
      });

      if (data.startsWith("buy_")) {
        const planTier = data.replace("buy_", "");
        const starsPrices = { starter: { title: "AuraStudio Starter (50 Gens)", stars: 250 }, unlimited: { title: "AuraStudio Unlimited", stars: 500 } };
        const selected = starsPrices[planTier] || starsPrices.starter;

        const invoiceRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: selected.title,
            description: `Instant AI Photo Studio generation package on Nvidia L40S GPU.`,
            payload: JSON.stringify({ user_id: userId, plan_tier: planTier }),
            currency: "XTR",
            prices: [{ label: selected.title, amount: selected.stars }]
          })
        });
        const invData = await invoiceRes.json();
        if (invData.ok && invData.result) {
          await sendTgMessage(chatId, `⭐️ *Оплата підписки ${selected.title}*\n\nНатисніть посилання нижче для оплати через Telegram Stars:`, {
            reply_markup: { inline_keyboard: [[{ text: `⭐️ Оплатити ${selected.stars} Stars`, url: invData.result }]] }
          });
        }
        return jsonResponse({ ok: true });
      }

      if (data.startsWith("preset_")) {
        const presetKey = data.replace("preset_", "");
        const prompt = anchorPromptForPhoto(GLOBAL_PRESETS[presetKey] || "enhance photo to studio magazine portrait");
        const isUltraHd = presetKey === "ultrahd_skin";
        const steps = 22;
        const negPrompt = isUltraHd
          ? "smooth plastic skin, airbrushed, porcelain doll, wax figure, beauty filter, blur, render, CGI, digital retouch, artificial skin, cartoon, 3d render, distorted eyes, changed face, altered eyes, different identity"
          : "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, painterly, soft focus, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts, extra fingers, text, watermark, deformed anatomy, bad proportions, bad lighting, changed face, altered eyes, different identity";
        
        const explicitFileId = cb.message?.photo?.[cb.message.photo.length - 1]?.file_id ||
                               cb.message?.reply_to_message?.photo?.[cb.message.reply_to_message.photo.length - 1]?.file_id;
        
        const photoData = await getTgUserPhotoBase64(env, botToken, userId, explicitFileId);

        if (photoData && photoData.base64) {
          let dailyUsedTg = 0;
          if (env.DB) {
            const isAdmin = isUserAdmin(userId, user.username, null, env);
            if (!isAdmin) {
              const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
              const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
              const dailyCountRow = await env.DB.prepare(`
                SELECT COUNT(*) as count
                FROM generations 
                WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
              `).bind(userId).first();

              dailyUsedTg = (dailyCountRow && dailyCountRow.count) || 0;

              if (dailyUsedTg >= DAILY_FREE_GENERATIONS_LIMIT) {
                if (!sub) {
                  if (u && (u.stars_balance || 0) >= (isUltraHd ? 20 : 10)) {
                    await env.DB.prepare("UPDATE users SET stars_balance = stars_balance - ? WHERE id = ?").bind(isUltraHd ? 20 : 10, userId).run();
                  } else {
                    await sendTgMessage(chatId, `⛔ *Щоденний безкоштовний ліміт вичерпано!*\n\nВи використали всі *${DAILY_FREE_GENERATIONS_LIMIT}* безкоштовних генерацій на сьогодні.\n\nПоповніть баланс Telegram Stars або підключіть тариф:`, {
                      reply_markup: {
                        inline_keyboard: [
                          [
                            { text: "⭐️ Купити Starter (250 Stars)", callback_data: "buy_starter" },
                            { text: "⭐️ Купити Unlimited (500 Stars)", callback_data: "buy_unlimited" }
                          ],
                          [
                            { text: "🌐 Відкрити Web Studio", url: "https://aurastudio-ai.memory1024.workers.dev" }
                          ]
                        ]
                      }
                    });
                    return jsonResponse({ ok: true });
                  }
                }
              }
            }
          }

          const targetTaskId = `tg_gen_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          await setTgSession(env, userId, { currentTaskId: targetTaskId });
          const styleLabel = isUltraHd ? "💎 ULTRA-HD CINEMA SKIN (4K MACRO)" : presetKey.toUpperCase();
          await sendTgMessage(chatId, `⏳ *Генеруємо трансформацію (${styleLabel})...*\n\n_${isUltraHd ? "Формуємо індивідуальні пори, пушкове волосся та мікрорельєф шкіри (~25-30с)" : "Зберігаємо 100% рис обличчя та деталізацію шкіри (~20-25с)"}_`);
          sendTgChatAction(chatId, "upload_photo");

          ctx.waitUntil(recordGenerationInD1(env, {
            id: targetTaskId,
            userId,
            source: "telegram_bot",
            presetId: presetKey,
            prompt,
            inputBase64: photoData.base64,
            outputBase64: null,
            duration: null,
            status: "PENDING"
          }));

          ctx.waitUntil((async () => {
            const startTime = Date.now();
            try {
              const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
                image_base64: photoData.base64,
                prompt: prompt,
                negative_prompt: negPrompt,
                steps: steps,
                cfg: 1.95,
                seed: 888424
              });

              const duration = ((Date.now() - startTime) / 1000).toFixed(1);

              if (mData.status === "success" && mData.result_base64) {
                await recordGenerationInD1(env, {
                  id: targetTaskId,
                  userId,
                  source: "telegram_bot",
                  presetId: presetKey,
                  prompt,
                  inputBase64: photoData.base64,
                  outputBase64: mData.result_base64,
                  duration,
                  status: "SUCCESS"
                });

                const freeTgLeft = Math.max(0, DAILY_FREE_GENERATIONS_LIMIT - (dailyUsedTg + 1));
                const quotaBadge = freeTgLeft > 0 ? `\n🎁 Залишилось безкоштовних: *${freeTgLeft} з ${DAILY_FREE_GENERATIONS_LIMIT}* на сьогодні` : `\n⭐️ Безкоштовний ліміт вичерпано (${DAILY_FREE_GENERATIONS_LIMIT}/${DAILY_FREE_GENERATIONS_LIMIT})`;

                await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nСтиль: *${styleLabel}*${quotaBadge}\nДвигун: Qwen 2.5 DiT 20B`, {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                    ]
                  }
                });
              } else {
                throw new Error(mData.message || "Model failed to return image result");
              }
            } catch(err) {
              const duration = ((Date.now() - startTime) / 1000).toFixed(1);
              console.error("TG generation error:", err);
              logCriticalError(env, ctx, "telegram_photo", err.message, userId);
              await recordGenerationInD1(env, {
                id: targetTaskId,
                userId,
                source: "telegram_bot",
                presetId: presetKey,
                prompt,
                inputBase64: null,
                outputBase64: null,
                duration,
                status: "FAILED",
                errorMessage: err.message
              });
              await sendTgMessage(chatId, "⚠️ Помилка генерації: " + err.message);
            }
          })());
        } else {
          await setTgSession(env, userId, { pendingAction: "preset", presetKey, prompt });
          const styleLabel = isUltraHd ? "💎 ULTRA-HD CINEMA SKIN" : presetKey.toUpperCase();
          await sendTgMessage(chatId, `✅ Обрано стиль *${styleLabel}*!\n\n📸 Тепер надішліть сюди своє селфі або фото для трансформації.`);
        }
        return jsonResponse({ ok: true });
      }
    }

    // 3. Handle Messages
    if (update.message) {
      const chatId = update.message.chat.id;
      const user = update.message.from || {};
      const text = update.message.text || "";
      const photos = update.message.photo;

      const userId = `tg_${user.id}`;
      const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.username || "Telegram User";

      if (env.DB && user.id) {
        ctx.waitUntil(
          env.DB.prepare(`
            INSERT OR IGNORE INTO users (id, username, name, auth_provider, free_generations_used, stars_balance)
            VALUES (?, ?, ?, 'telegram', 0, 0)
          `).bind(userId, user.username || null, userName).run()
        );
      }

      // Handle Successful Star Payment
      if (update.message.successful_payment) {
        const payment = update.message.successful_payment;
        const starsAmount = payment.total_amount;
        const payload = JSON.parse(payment.invoice_payload || "{}");
        const planTier = payload.plan_tier || "starter";
        const targetUserId = payload.user_id || userId;

        if (env.DB) {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO subscriptions (id, user_id, stripe_customer_id, plan_tier, status, monthly_credits_limit, credits_used_this_period)
            VALUES (?, ?, ?, ?, 'active', 50, 0)
          `).bind(`star_sub_${Date.now()}`, targetUserId, `tg_${chatId}`, planTier).run();

          await env.DB.prepare(`
            UPDATE users SET stars_balance = COALESCE(stars_balance, 0) + ? WHERE id = ?
          `).bind(starsAmount, targetUserId).run();

          await env.DB.prepare(`
            INSERT INTO telemetry_events (event_type, source, user_id, stars_amount, details)
            VALUES ('STARS_PURCHASE', 'telegram_bot', ?, ?, ?)
          `).bind(targetUserId, starsAmount, JSON.stringify(payment)).run();
        }

        await sendTgMessage(chatId, `⭐️ *Дякуємо за оплату!*\n\nВаша підписка *${planTier.toUpperCase()}* (+${starsAmount} Stars) успішно активована! Баланс оновлено.`);
        return jsonResponse({ ok: true });
      }

      // Handle Deep Link Login: /start auth_XYZ
      if (text.startsWith("/start auth_")) {
        const sessionCode = text.replace("/start ", "").trim();
        if (authSessions.has(sessionCode)) {
          authSessions.set(sessionCode, {
            status: "verified",
            user: { id: userId, username: user.username, name: userName, auth_provider: "telegram", free_generations_used: 0 }
          });

          await sendTgMessage(chatId, `✅ *Вхід успішно підтверджено!*\n\nВи увійшли на веб-сайті AuraStudio.AI під акаунтом *${userName}*. Можете повертатися до браузера!`);
          return jsonResponse({ ok: true });
        }
      }

      const lowerText = text.trim().toLowerCase();
      const isAdmin = isUserAdmin(userId, user.username, null, env);

      // Handle Balance
      if (lowerText === "/balance" || lowerText.startsWith("/balance") || lowerText === "balance" || lowerText === "баланс" || lowerText.includes("баланс")) {
        let balance = 0;
        let subStatus = "Немає активної підписки";
        if (env.DB) {
          const u = await env.DB.prepare("SELECT stars_balance FROM users WHERE id = ?").bind(userId).first();
          if (u && u.stars_balance !== undefined) balance = u.stars_balance;
          const sub = await env.DB.prepare("SELECT plan_tier, status FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
          if (sub) subStatus = `Активна (${sub.plan_tier.toUpperCase()})`;
        }

        await sendTgMessage(chatId, `⭐️ *Ваш баланс та підписка:*\n\n• ⭐️ *Баланс Stars:* ${balance} XTR\n• 📦 *Статус підписки:* ${subStatus}\n\n_Використовуйте баланс:_\n• 📸 Студійне фото: *10 Stars*\n• 💎 Ultra-HD Cinema Skin (4K): *20 Stars*`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⭐️ Купити Starter (250 Stars)", callback_data: "buy_starter" },
                { text: "⭐️ Купити Unlimited (500 Stars)", callback_data: "buy_unlimited" }
              ],
              [
                { text: "🌐 Перейти на AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }
              ]
            ]
          }
        });
        return jsonResponse({ ok: true });
      }

      // Handle Help
      if (lowerText === "/help" || lowerText.startsWith("/help") || lowerText === "help" || lowerText === "допомога" || lowerText === "інструкція") {
        const helpText = "ℹ️ *AuraStudio AI — Довідка та команди:*\n\n" +
          "💎 *Ultra-HD Cinema Skin (4K)* — Макро-пори, пушкове волосся та 8K текстура (20 ⭐️)\n" +
          "🏠 */start* — Головне меню та відкриття Web App\n" +
          "⭐️ */balance* — Баланс Telegram Stars та тарифи\n\n" +
          "📸 *Як створити фото:* просто надішліть будь-яке фото сюди та оберіть стиль (💎 Ultra-HD Skin, LinkedIn, Old Money, Blonde) або додайте текстовий опис.\n\n" +
          "🌐 *Веб-версія:* https://aurastudio-ai.memory1024.workers.dev";
        await sendTgMessage(chatId, helpText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✨ Відкрити Web Studio", web_app: { url: "https://aurastudio-ai.memory1024.workers.dev" } }]
            ]
          }
        });
        return jsonResponse({ ok: true });
      }

      // Handle Photo Upload
      if (photos && photos.length > 0) {
        const bestPhoto = photos[photos.length - 1];
        const session = await getTgSession(env, userId);
        const caption = update.message.caption || "";

        if (caption) {
          const targetTaskId = session.currentTaskId || `tg_gen_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          await setTgSession(env, userId, { lastPhotoFileId: bestPhoto.file_id, currentTaskId: targetTaskId });

          await sendTgMessage(chatId, `⏳ *Генеруємо трансформацію за вашим описом:*\n_"${caption}"_...`);
          ctx.waitUntil((async () => {
            const startTime = Date.now();
            try {
              const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
              const fileData = await fileRes.json();
              if (!fileData.ok) throw new Error("Could not fetch photo from Telegram: " + (fileData.description || ""));

              const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
              const photoBuffer = await photoBlobRes.arrayBuffer();
              const photoBase64 = arrayBufferToBase64(photoBuffer);

              const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
                image_base64: photoBase64,
                prompt: caption,
                negative_prompt: "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts",
                steps: 12,
                cfg: 1.95,
                seed: 888424
              });

              const duration = ((Date.now() - startTime) / 1000).toFixed(1);

              if (mData.status === "success" && mData.result_base64) {
                await recordGenerationInD1(env, {
                  id: targetTaskId,
                  userId,
                  source: "telegram_bot",
                  presetId: "custom",
                  prompt: caption,
                  inputBase64: photoBase64,
                  outputBase64: mData.result_base64,
                  duration,
                  status: "SUCCESS"
                });

                await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nОпис: _"${caption}"_`);
              } else {
                throw new Error(mData.message || "Model failed to return image result");
              }
            } catch (err) {
              const duration = ((Date.now() - startTime) / 1000).toFixed(1);
              logCriticalError(env, ctx, "telegram_photo", err.message, userId);
              await recordGenerationInD1(env, {
                id: targetTaskId,
                userId,
                source: "telegram_bot",
                presetId: "custom",
                prompt: caption,
                inputBase64: null,
                outputBase64: null,
                duration,
                status: "FAILED",
                errorMessage: err.message
              });
              await sendTgMessage(chatId, `❌ Помилка генерації фото: ${err.message}`);
            }
          })());
        } else {
          const taskId = `tg_gen_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          await setTgSession(env, userId, { 
            lastPhotoFileId: bestPhoto.file_id, 
            currentTaskId: taskId,
            pendingAction: null, 
            pendingStyle: null 
          });

          ctx.waitUntil((async () => {
            try {
              const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
              const fileData = await fileRes.json();
              if (fileData.ok && fileData.result?.file_path) {
                const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                const photoBuffer = await photoBlobRes.arrayBuffer();
                const photoBase64 = arrayBufferToBase64(photoBuffer);

                await recordGenerationInD1(env, {
                  id: taskId,
                  userId,
                  source: "telegram_bot",
                  presetId: "awaiting_selection",
                  prompt: "Фото завантажено (очікує вибору пресету)",
                  inputBase64: photoBase64,
                  outputBase64: null,
                  duration: null,
                  status: "PENDING"
                });
              }
            } catch(err) {
              console.error("Failed to journal incoming photo in D1:", err);
            }
          })());

          await sendTgMessage(chatId, `📸 *Фото отримано!* Оберіть бажаний стиль:`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "💎 Ultra-HD Macro Skin (4K)", callback_data: "preset_ultrahd_skin" },
                  { text: "💼 LinkedIn Pro", callback_data: "preset_linkedin" }
                ],
                [
                  { text: "🍸 Old Money", callback_data: "preset_old_money" },
                  { text: "👱‍♀️ Blonde Restyle", callback_data: "preset_blonde" }
                ],
                [
                  { text: "🌴 Bali Sunset", callback_data: "preset_bali" },
                  { text: "⚡ Cyberpunk", callback_data: "preset_cyberpunk" }
                ],
                [
                  { text: "🎭 Muppet Meme", callback_data: "preset_muppet" },
                  { text: "🤪 3D Goofy", callback_data: "preset_goofy3d" }
                ],
                [
                  { text: "🌐 Відкрити Web Studio", url: "https://aurastudio-ai.memory1024.workers.dev" },
                  { text: "⭐ Отримати Pro", callback_data: "buy_starter" }
                ]
              ]
            }
          });
        }
        return jsonResponse({ ok: true });
      }

      // Handle Custom Text Prompt
      if (text && !text.startsWith("/")) {
        const replyPhotos = update.message.reply_to_message?.photo;
        const replyPhotoId = replyPhotos && replyPhotos.length > 0 ? replyPhotos[replyPhotos.length - 1].file_id : null;
        const photoData = await getTgUserPhotoBase64(env, botToken, userId, replyPhotoId);

        const hasPhoto = !!(photoData && photoData.base64);
        const effectivePhotoBase64 = hasPhoto ? photoData.base64 : DEFAULT_BLANK_CANVAS_BASE64;
        const modeLabel = hasPhoto ? "Image-to-Image" : "Text-to-Image (генерація з нуля)";
        const presetId = hasPhoto ? "custom" : "text_to_image";

        let dailyUsedTg = 0;
        if (env.DB && !isAdmin) {
          const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
          const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
          const dailyCountRow = await env.DB.prepare(`
            SELECT COUNT(*) as count
            FROM generations 
            WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
          `).bind(userId).first();

          dailyUsedTg = (dailyCountRow && dailyCountRow.count) || 0;

          if (dailyUsedTg >= DAILY_FREE_GENERATIONS_LIMIT) {
            if (!sub && (!u || (u.stars_balance || 0) < 10)) {
              await sendTgMessage(chatId, `⛔ *Щоденний безкоштовний ліміт вичерпано!*\n\nВи використали всі *${DAILY_FREE_GENERATIONS_LIMIT}* безкоштовних генерацій на сьогодні.\n\nПоповніть баланс Telegram Stars (⭐️ 10 за генерацію) або підключіть тариф:`, {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "⭐️ Купити Starter (250 Stars)", callback_data: "buy_starter" },
                      { text: "⭐️ Купити Unlimited (500 Stars)", callback_data: "buy_unlimited" }
                    ],
                    [
                      { text: "🌐 Відкрити Web Studio", url: "https://aurastudio-ai.memory1024.workers.dev" }
                    ]
                  ]
                }
              });
              return jsonResponse({ ok: true });
            } else if (!sub && u && (u.stars_balance || 0) >= 10) {
              await env.DB.prepare("UPDATE users SET stars_balance = stars_balance - 10 WHERE id = ?").bind(userId).run();
            }
          }
        }

        const targetTaskId = `tg_gen_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        await setTgSession(env, userId, { currentTaskId: targetTaskId });

        const statusHint = hasPhoto
          ? "_Зберігаємо 100% рис обличчя та деталізацію (~20-25с)_"
          : "_Малюємо нову сцену за описом на базі Qwen 2.1 DiT 20B (~20-25с)_";

        await sendTgMessage(chatId, `⏳ *Генеруємо зображення (${modeLabel}):*\n_"${text}"_...\n\n${statusHint}`);
        sendTgChatAction(chatId, "upload_photo");

        ctx.waitUntil(recordGenerationInD1(env, {
          id: targetTaskId,
          userId,
          source: "telegram_bot",
          presetId,
          prompt: text,
          inputBase64: hasPhoto ? photoData.base64 : null,
          outputBase64: null,
          duration: null,
          status: "PENDING"
        }));

        ctx.waitUntil((async () => {
          const startTime = Date.now();
          try {
            const finalPrompt = hasPhoto
              ? anchorPromptForPhoto(text)
              : `candid 8k dslr photograph, ultra-detailed, cinematic soft lighting, realistic depth of field, photorealistic, ${text}`;

            const cleanNeg = hasPhoto
              ? "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, painterly, soft focus, distorted eyes, neck smudges, black dots, stippling, pepper noise, artifacts, extra fingers, text, watermark, deformed anatomy, bad proportions, bad lighting, changed face, altered eyes, different identity"
              : "blurry, low quality, distorted, bad anatomy, artifacts, malformed, extra limbs, text, watermark";

            const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
              image_base64: effectivePhotoBase64,
              prompt: finalPrompt,
              negative_prompt: cleanNeg,
              steps: 22,
              cfg: 1.95,
              seed: 888424
            });

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            if (mData.status === "success" && mData.result_base64) {
              await recordGenerationInD1(env, {
                id: targetTaskId,
                userId,
                source: "telegram_bot",
                presetId,
                prompt: text,
                inputBase64: hasPhoto ? photoData.base64 : null,
                outputBase64: mData.result_base64,
                duration,
                status: "SUCCESS"
              });

              const freeTgLeft = Math.max(0, DAILY_FREE_GENERATIONS_LIMIT - (dailyUsedTg + 1));
              const quotaBadge = freeTgLeft > 0 ? `\n🎁 Залишилось безкоштовних: *${freeTgLeft} з ${DAILY_FREE_GENERATIONS_LIMIT}* на сьогодні` : `\n⭐️ Безкоштовний ліміт вичерпано (${DAILY_FREE_GENERATIONS_LIMIT}/${DAILY_FREE_GENERATIONS_LIMIT})`;
              const tipStr = hasPhoto ? "" : "\n\n💡 _Підказка: якщо надішлете селфі, Qwen змінить ваш стиль зі збереженням 100% рис обличчя!_";

              await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nРежим: *${modeLabel}*\nОпис: _"${text}"_${quotaBadge}${tipStr}\nДвигун: Qwen 2.1 DiT 20B`, {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                  ]
                }
              });
            } else {
              throw new Error(mData.message || "Model failed to return image result");
            }
          } catch(err) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.error("Custom prompt TG generation error:", err);
            logCriticalError(env, ctx, "telegram_photo", err.message, userId);
            await recordGenerationInD1(env, {
              id: targetTaskId,
              userId,
              source: "telegram_bot",
              presetId,
              prompt: text,
              inputBase64: null,
              outputBase64: null,
              duration,
              status: "FAILED",
              errorMessage: err.message
            });
            await sendTgMessage(chatId, `❌ Помилка генерації фото: ${err.message}`);
          }
        })());
        return jsonResponse({ ok: true });
      }

      // Default Greeting
      const welcomeText = "✨ *Ласкаво просимо до AuraStudio AI!* ✨\n\n🎨 *Студійні портрети, ділові фото та стильні луки за 30 секунд!*\n\n• 📸 *LinkedIn Pro Headshot*\n• 👗 *Old Money Aesthetic*\n• 🌴 *Bali Sunset Travel*\n\n👇 *Оберіть дію або надішліть фото:*";
      const webUrl = "https://aurastudio-ai.memory1024.workers.dev";
      const welcomeButtons = [
        [{ text: "✨ Відкрити AI Studio (Web App)", web_app: { url: webUrl } }],
        [{ text: "⭐️ Мій Баланс Stars / Підписка", callback_data: "buy_starter" }],
        [{ text: "🌐 Відкрити веб-сайт", url: webUrl }]
      ];

      await sendTgMessage(chatId, welcomeText, {
        reply_markup: { inline_keyboard: welcomeButtons }
      });
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    logCriticalError(env, ctx, "telegram_webhook", e.message, null);
    return jsonResponse({ ok: false, error: e.message });
  }
}
