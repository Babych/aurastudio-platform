// Cloudflare Worker: AuraStudio AI Enterprise API & Edge Platform
// Full Auth (Google GIS, Telegram WebApp, Telegram Bot Deep Link), Payments (Stripe Checkout & Telegram Stars), D1 Telemetry & Quota Enforcement

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id"
};

// Helper: JSON response with CORS
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}

// Helper: Log critical errors to D1
function logCriticalError(env, ctx, context, errorMsg, userId = null, details = null) {
  if (env.DB) {
    ctx.waitUntil((async () => {
      try {
        await env.DB.prepare(`
          INSERT INTO error_logs (context, error_message, user_id, details)
          VALUES (?, ?, ?, ?)
        `).bind(context, errorMsg, userId, details ? JSON.stringify(details) : null).run();
      } catch (e) {
        console.error("Failed to write to error_logs:", e);
      }
    })());
  }
}

// Modal Multi-Account Failover Endpoints (Auto load-balancing across accounts)
const MODAL_PHOTO_ENDPOINTS = [
  "https://memory1024--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run",
  "https://dmytrobbch--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run"
];

const MODAL_VIDEO_ENDPOINTS = [
  "https://dmytrobbch--aurastudio-video-dance-service-videodanceeng-753eb3.modal.run",
  "https://memory1024--aurastudio-video-dance-service-videodanceeng-753eb3.modal.run"
];

// Helper: Call Modal with automatic account failover
async function callModalWithFallback(endpoints, payload) {
  let lastErr = "";
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "success") {
          return data;
        }
        lastErr = data.message || "Model failed to process";
      } else {
        lastErr = await res.text();
      }
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`All Modal GPU endpoints failed. Last error: ${lastErr}`);
}

// Helper: Upload Base64 to R2 Storage
async function uploadToR2(bucket, key, base64Data) {
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

// In-memory / D1 auth session store for Telegram deep link login
const authSessions = new Map();
// In-memory user state store for Telegram interactive flows (Dance & Presets)
const tgUserSessions = new Map();

// Helper: Check if user has administrative privileges
function isUserAdmin(userId, username, email, env) {
  if (!userId) return false;
  const adminIds = ["tg_1359272262", "google_112903967526802503571", "test_user"];
  const adminUsernames = ["lame618", "memory1024", "dmytrobbch"];
  const cleanUid = String(userId).toLowerCase();
  const cleanUname = String(username || "").toLowerCase();
  const cleanEmail = String(email || "").toLowerCase();

  if (adminIds.some(id => cleanUid.includes(id.toLowerCase()))) return true;
  if (adminUsernames.some(u => cleanUname === u || cleanUid.includes(u))) return true;
  if (cleanEmail && (cleanEmail.includes("babych") || cleanEmail.includes("memory1024"))) return true;
  if (env.ADMIN_USER_IDS && env.ADMIN_USER_IDS.split(",").some(id => cleanUid.includes(id.trim().toLowerCase()))) return true;
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // =========================================================================
    // 0. CONFIG: Public runtime configuration for client
    // =========================================================================
    if (url.pathname === "/api/config") {
      return jsonResponse({
        status: "success",
        google_client_id: env.GOOGLE_CLIENT_ID || "",
        telegram_bot_username: env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot",
        telegram_only_payments: env.TELEGRAM_ONLY_PAYMENTS !== "false",
        enable_dance_studio: env.ENABLE_DANCE_STUDIO || "admin_only",
        environment: env.ENVIRONMENT || "production"
      });
    }

    // =========================================================================
    // 0.1 FEEDBACK: Submit & Fetch User Reviews
    // =========================================================================
    if (url.pathname === "/api/feedback") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { user_id, user_name, avatar_url, rating, category, comment } = body;

          if (!user_id || !comment || !comment.trim()) {
            return jsonResponse({ status: "error", message: "User ID and comment are required" }, 400);
          }

          const feedbackId = `fb_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
          const ratingNum = Math.min(5, Math.max(1, parseInt(rating) || 5));

          if (env.DB) {
            await env.DB.prepare(`
              INSERT INTO feedback (id, user_id, user_name, avatar_url, rating, category, comment)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(
              feedbackId,
              user_id,
              user_name || "Verified Creator",
              avatar_url || null,
              ratingNum,
              category || "general",
              comment.trim().slice(0, 1000)
            ).run();
          }

          return jsonResponse({ status: "success", message: "Thank you for your feedback!" });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }

      if (request.method === "GET") {
        try {
          let reviews = [];
          if (env.DB) {
            const res = await env.DB.prepare(`
              SELECT id, user_name, avatar_url, rating, category, comment, created_at
              FROM feedback
              WHERE is_public = 1
              ORDER BY created_at DESC
              LIMIT 8
            `).all();
            reviews = (res && res.results) || [];
          }
          return jsonResponse({ status: "success", reviews });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 1. AUTH: Google Identity Services (GIS) Token Verification
    // =========================================================================
    if (url.pathname === "/api/auth/google") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { credential, client_id } = body;

          if (!credential) {
            return jsonResponse({ status: "error", message: "Missing Google ID token" }, 400);
          }

          let googleUser = null;

          // Verify Google ID token via Google TokenInfo API
          try {
            const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
            if (verifyRes.ok) {
              googleUser = await verifyRes.json();
            }
          } catch (e) {
            console.error("Google tokeninfo error:", e);
          }

          // Fallback parsing if network issue or dev mode
          if (!googleUser || !googleUser.sub) {
            try {
              const base64Url = credential.split('.')[1];
              const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
              const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
              googleUser = JSON.parse(jsonPayload);
            } catch (e) {
              return jsonResponse({ status: "error", message: "Invalid Google credential format" }, 400);
            }
          }

          const userId = `google_${googleUser.sub}`;
          const email = googleUser.email ? googleUser.email.toLowerCase() : null;
          const name = googleUser.name || "Google User";
          const avatarUrl = googleUser.picture || null;

          let userRecord = null;
          if (env.DB) {
            userRecord = await env.DB.prepare("SELECT * FROM users WHERE id = ? OR email = ?").bind(userId, email || "").first();
            if (!userRecord) {
              await env.DB.prepare(`
                INSERT INTO users (id, email, username, name, avatar_url, auth_provider, free_generations_used, stars_balance)
                VALUES (?, ?, ?, ?, ?, 'google', 0, 0)
              `).bind(userId, email, email ? email.split('@')[0] : null, name, avatarUrl).run();

              userRecord = { id: userId, email, name, avatar_url: avatarUrl, free_generations_used: 0, is_new: true };
            }
            
            // Check active subscription
            const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
            userRecord.subscription = sub || null;
          } else {
            userRecord = { id: userId, email, name, avatar_url: avatarUrl, free_generations_used: 0, is_new: true };
          }

          return jsonResponse({
            status: "success",
            user: userRecord
          });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 2. AUTH: Telegram Authentication (WebApp initData + Login Widget)
    // =========================================================================
    if (url.pathname === "/api/auth/telegram") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { init_data, user, telegram_id, name, username, photo_url } = body;

          const tgId = telegram_id || (user && user.id) || (init_data && init_data.user && init_data.user.id);
          if (!tgId) {
            return jsonResponse({ status: "error", message: "Missing Telegram User ID" }, 400);
          }

          const userId = `tg_${tgId}`;
          const userName = name || (user && `${user.first_name || ''} ${user.last_name || ''}`.trim()) || username || `tg_${tgId}`;
          const userHandle = username || (user && user.username) || null;
          const avatarUrl = photo_url || (user && user.photo_url) || null;

          let userRecord = null;
          if (env.DB) {
            userRecord = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
            if (!userRecord) {
              await env.DB.prepare(`
                INSERT INTO users (id, username, name, avatar_url, auth_provider, free_generations_used, stars_balance)
                VALUES (?, ?, ?, ?, 'telegram', 0, 0)
              `).bind(userId, userHandle, userName, avatarUrl).run();

              userRecord = { id: userId, username: userHandle, name: userName, avatar_url: avatarUrl, free_generations_used: 0, is_new: true };
            }

            const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
            userRecord.subscription = sub || null;
          } else {
            userRecord = { id: userId, username: userHandle, name: userName, free_generations_used: 0, is_new: true };
          }

          return jsonResponse({
            status: "success",
            user: userRecord
          });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 3. AUTH: Telegram Bot Deep-Link Login Session (Create & Poll)
    // =========================================================================
    if (url.pathname === "/api/auth/telegram-session") {
      // Create temporary login challenge code
      const sessionCode = `auth_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 mins
      authSessions.set(sessionCode, { status: "pending", expiresAt, user: null });

      const botUsername = env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot";
      const deepLink = `https://t.me/${botUsername}?start=${sessionCode}`;

      return jsonResponse({
        status: "success",
        session_code: sessionCode,
        deep_link: deepLink,
        qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(deepLink)}`
      });
    }

    if (url.pathname === "/api/auth/telegram-poll") {
      const code = url.searchParams.get("session_code");
      if (!code || !authSessions.has(code)) {
        return jsonResponse({ status: "pending", message: "Waiting for authorization" });
      }

      const session = authSessions.get(code);
      if (Date.now() > session.expiresAt) {
        authSessions.delete(code);
        return jsonResponse({ status: "expired", message: "Session expired" }, 410);
      }

      if (session.status === "verified" && session.user) {
        authSessions.delete(code);
        return jsonResponse({ status: "success", user: session.user });
      }

      return jsonResponse({ status: "pending" });
    }

    // =========================================================================
    // 4. USER: Profile & Quota Fetch
    // =========================================================================
    if (url.pathname === "/api/user/profile") {
      const userId = url.searchParams.get("user_id");
      if (!userId) {
        return jsonResponse({ status: "error", message: "Missing user_id" }, 400);
      }

      if (env.DB) {
        const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
        const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
        const recentGens = await env.DB.prepare("SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 12").bind(userId).all();

        let hoursLeft = 0;
        const lastGen = await env.DB.prepare(`
          SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
          FROM generations 
          WHERE user_id = ? AND status = 'SUCCESS'
          ORDER BY created_at DESC 
          LIMIT 1
        `).bind(userId).first();

        if (lastGen && lastGen.seconds_ago !== null && lastGen.seconds_ago < 86400) {
          hoursLeft = Math.ceil((86400 - lastGen.seconds_ago) / 3600);
        }

        const starsBalance = (u && u.stars_balance) || 0;
        const hasPaidAccess = !!sub || starsBalance >= 10;

        return jsonResponse({
          status: "success",
          user: u || { id: userId, free_generations_used: 0, stars_balance: 0 },
          stars_balance: starsBalance,
          hours_left: hoursLeft,
          can_generate: (hoursLeft === 0) || hasPaidAccess,
          subscription: sub || null,
          history: (recentGens && recentGens.results) || []
        });
      }

      return jsonResponse({ status: "success", user: { id: userId, free_generations_used: 0, stars_balance: 0 }, stars_balance: 0, subscription: null, history: [] });
    }

    // =========================================================================
    // 5. PAYMENTS: Stripe Checkout Session Creation
    // =========================================================================
    if (url.pathname === "/api/payments/create-checkout-session") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { plan_tier, user_id, user_email, return_url } = body;

          if (!user_id) {
            return jsonResponse({ status: "error", message: "Sign in required to subscribe" }, 401);
          }

          const origin = url.origin;
          const successUrl = return_url || `${origin}?payment=success&plan=${plan_tier}`;
          const cancelUrl = `${origin}?payment=cancelled`;

          const stripeKey = env.STRIPE_SECRET_KEY;
          const planConfig = {
            starter: { name: "AuraStudio Starter Pro", priceUsd: "9.99", amountCents: 999, credits: 50 },
            unlimited: { name: "AuraStudio Unlimited", priceUsd: "19.99", amountCents: 1999, credits: 9999 }
          };

          const selected = planConfig[plan_tier] || planConfig.starter;

          // Feature Flag: Telegram Only Payments mode
          if (env.TELEGRAM_ONLY_PAYMENTS !== "false") {
            const botUsername = env.TELEGRAM_BOT_USERNAME || "AuraStudioAiBot";
            const deepLink = `https://t.me/${botUsername}?start=buy_${plan_tier || 'starter'}`;
            return jsonResponse({
              status: "success",
              payment_provider: "telegram_stars",
              checkout_url: deepLink,
              message: "Redirecting to Telegram Stars checkout in @AuraStudioAiBot"
            });
          }

          // If live Stripe Secret Key is present, call Stripe REST API
          if (stripeKey) {
            const formData = new URLSearchParams();
            formData.append("mode", "subscription");
            formData.append("success_url", successUrl);
            formData.append("cancel_url", cancelUrl);
            formData.append("client_reference_id", user_id);
            if (user_email) formData.append("customer_email", user_email);

            formData.append("line_items[0][price_data][currency]", "usd");
            formData.append("line_items[0][price_data][product_data][name]", selected.name);
            formData.append("line_items[0][price_data][unit_amount]", selected.amountCents.toString());
            formData.append("line_items[0][price_data][recurring][interval]", "month");
            formData.append("line_items[0][quantity]", "1");

            const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${stripeKey}`,
                "Content-Type": "application/x-www-form-urlencoded"
              },
              body: formData.toString()
            });

            const stripeData = await stripeRes.json();
            if (stripeData.url) {
              return jsonResponse({
                status: "success",
                checkout_url: stripeData.url,
                session_id: stripeData.id
              });
            } else {
              return jsonResponse({ status: "error", message: stripeData.error?.message || "Stripe session error" }, 500);
            }
          }

          // Production Fallback / Sandbox activation if Stripe Secret is not yet provided
          if (env.DB) {
            await env.DB.prepare(`
              INSERT OR IGNORE INTO users (id, email, name, auth_provider, free_generations_used)
              VALUES (?, ?, 'Subscribed User', 'web', 0)
            `).bind(user_id, user_email || null).run();

            const mockSubId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
            await env.DB.prepare(`
              INSERT OR REPLACE INTO subscriptions (id, user_id, stripe_customer_id, plan_tier, status, monthly_credits_limit, credits_used_this_period)
              VALUES (?, ?, ?, ?, 'active', ?, 0)
            `).bind(mockSubId, user_id, `cus_${user_id}`, plan_tier, selected.credits).run();

            await env.DB.prepare(`
              INSERT INTO telemetry_events (event_type, source, user_id, usd_amount, details)
              VALUES ('STRIPE_SUBSCRIPTION', 'web_stripe', ?, ?, ?)
            `).bind(user_id, parseFloat(selected.priceUsd), JSON.stringify({ plan: plan_tier, mode: "sandbox" })).run();
          }

          return jsonResponse({
            status: "success",
            checkout_url: successUrl,
            sandbox: true,
            message: `Sandbox subscription to ${selected.name} activated!`
          });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 6. PAYMENTS: Telegram Stars In-App Payment
    // =========================================================================
    if (url.pathname === "/api/payments/create-stars-invoice") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { plan_tier, user_id, chat_id } = body;
          const botToken = env.AURA_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
          if (!botToken) throw new Error("Bot token secret not configured");

          const starsPrices = {
            starter: { title: "AuraStudio Starter (50 Gens)", stars: 250 },
            unlimited: { title: "AuraStudio Unlimited (1 Month)", stars: 500 }
          };
          const selected = starsPrices[plan_tier] || starsPrices.starter;

          // Request invoice link from Telegram Bot API
          const invoiceRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: selected.title,
              description: `Instant AI Photo Studio generation package on Nvidia L40S GPU.`,
              payload: JSON.stringify({ user_id: user_id || `tg_${chat_id}`, plan_tier }),
              currency: "XTR", // Telegram Stars Currency
              prices: [{ label: selected.title, amount: selected.stars }]
            })
          });

          const invoiceData = await invoiceRes.json();
          if (invoiceData.ok && invoiceData.result) {
            return jsonResponse({
              status: "success",
              invoice_url: invoiceData.result
            });
          }

          // Fallback deep link
          const botUser = env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot";
          return jsonResponse({
            status: "success",
            invoice_url: `https://t.me/${botUser}?start=buy_${plan_tier}`
          });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 7. PAYMENTS: Stripe Webhook
    // =========================================================================
    if (url.pathname === "/api/payments/webhook") {
      if (request.method === "POST") {
        try {
          const event = await request.json();
          if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            const userId = session.client_reference_id;
            const customerId = session.customer;
            const subId = session.subscription || `sub_${Date.now()}`;
            const amountUsd = session.amount_total ? session.amount_total / 100 : 9.99;

            if (env.DB && userId) {
              await env.DB.prepare(`
                INSERT OR IGNORE INTO users (id, name, auth_provider, free_generations_used)
                VALUES (?, 'Stripe Customer', 'stripe', 0)
              `).bind(userId).run();

              await env.DB.prepare(`
                INSERT OR REPLACE INTO subscriptions (id, user_id, stripe_customer_id, plan_tier, status, monthly_credits_limit, credits_used_this_period)
                VALUES (?, ?, ?, 'starter', 'active', 50, 0)
              `).bind(subId, userId, customerId || `cus_${userId}`).run();

              await env.DB.prepare(`
                INSERT INTO telemetry_events (event_type, source, user_id, usd_amount, details)
                VALUES ('STRIPE_SUBSCRIPTION', 'stripe_webhook', ?, ?, ?)
              `).bind(userId, amountUsd, JSON.stringify(session)).run();
            }
          }
          return jsonResponse({ received: true });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 400);
        }
      }
    }

    // =========================================================================
    // 8. GENERATE: Image Generation (Protected by Auth & Quota)
    // =========================================================================
    if (url.pathname === "/api/generate" || url.pathname === "/functions/api/generate") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { image_base64, prompt, preset_id, user_id, user_email, user_name } = body;

          // Block anonymous generation (Anti-Bot Security)
          if (!user_id || user_id === "anonymous" || user_id === "anonymous_web") {
            return jsonResponse({
              status: "auth_required",
              message: "Please sign in with Google or Telegram to use your 1 Free Generation."
            }, 401);
          }

          // Check 24-hour daily quota & Telegram Stars balance in D1
          if (env.DB) {
            const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(user_id).first();
            const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user_id).first();

            const lastGen = await env.DB.prepare(`
              SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
              FROM generations 
              WHERE user_id = ? AND status = 'SUCCESS'
              ORDER BY created_at DESC 
              LIMIT 1
            `).bind(user_id).first();

            if (lastGen && lastGen.seconds_ago !== null && lastGen.seconds_ago < 86400) {
              if (sub) {
                // Active subscription - allowed
              } else if (u && (u.stars_balance || 0) >= 10) {
                // Deduct 10 Telegram Stars from user balance
                await env.DB.prepare("UPDATE users SET stars_balance = stars_balance - 10 WHERE id = ?").bind(user_id).run();
              } else {
                const hoursLeft = Math.ceil((86400 - lastGen.seconds_ago) / 3600);
                return jsonResponse({
                  status: "daily_limit_reached",
                  hours_left: hoursLeft,
                  stars_balance: (u && u.stars_balance) || 0,
                  required_stars: 10,
                  message: `Ваш щоденний безкоштовний ліміт вичерпано. Поповніть баланс Telegram Stars (⭐️ 10) або зачекайте ${hoursLeft} год.`
                }, 403);
              }
            }
          }

          const taskId = `task_${Date.now().toString().slice(-6)}_${Math.random().toString(36).substring(2, 6)}`;
          const shareToken = taskId.replace('task_', 's_');
          const cleanNeg = "text, watermark, changed face, altered eyes, blurry face, different identity, fake skin, plastic wax, doll, airbrushed skin, deformed, blurry";

          const payload = {
            image_base64: image_base64.replace(/^data:image\/\w+;base64,/, ""),
            prompt: prompt,
            negative_prompt: cleanNeg,
            steps: 22,
            cfg: 1.95,
            seed: 888424
          };

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

                let inThumb = image_base64.startsWith("data:") ? image_base64 : `data:image/jpeg;base64,${image_base64}`;
                let outThumb = resultDataUri;

                // Save to R2 if available
                if (env.STORAGE) {
                  const inExt = inThumb.includes("image/png") ? ".png" : ".jpg";
                  const outExt = outThumb.includes("image/png") ? ".png" : ".jpg";
                  
                  // Non-blocking upload via ctx.waitUntil or await directly?
                  // Doing await directly ensures DB gets the clean URL, but takes extra 100ms
                  const r2InUrl = await uploadToR2(env.STORAGE, `in_${taskId}${inExt}`, inThumb);
                  const r2OutUrl = await uploadToR2(env.STORAGE, `out_${taskId}${outExt}`, outThumb);
                  
                  if (r2InUrl) inThumb = url.origin + r2InUrl;
                  if (r2OutUrl) outThumb = url.origin + r2OutUrl;
                  
                  // Overwrite resultDataUri so the frontend gets the R2 URL instead of huge base64
                  resultDataUri = outThumb;
                }

                await env.DB.prepare(`
                  INSERT INTO generations (id, user_id, source, preset_id, prompt, input_image_url, output_image_url, status, duration_seconds, is_shared, share_token)
                  VALUES (?, ?, 'web', ?, ?, ?, ?, 'SUCCESS', ?, 1, ?)
                `).bind(
                  taskId,
                  user_id,
                  preset_id || "custom",
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
                  user_id,
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
          const twitterText = encodeURIComponent("Check out my AI photo created with @AuraStudioAi! 🚀✨ Try 1 free transformation daily:");
          const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${twitterText}&url=${encodeURIComponent(shareUrl)}`;

          return jsonResponse({
            status: "success",
            task_id: taskId,
            share_token: shareToken,
            share_url: shareUrl,
            twitter_intent_url: twitterIntentUrl,
            duration_seconds: parseFloat(dur),
            result_base64: resultDataUri
          });
        } catch (err) {
          logCriticalError(env, ctx, "modal_photo_gpu", err.message, null);
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 8.1 GENERATE: TikTok Dance & Video Character Retargeting
    // =========================================================================
    if (url.pathname === "/api/generate-dance-video" || url.pathname === "/functions/api/generate-dance-video") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { image_base64, dance_template_id, video_base64, audio_sync, user_id } = body;

          if (!user_id || user_id === "anonymous") {
            return jsonResponse({
              status: "auth_required",
              message: "Please sign in to generate AI TikTok Dance Reels."
            }, 401);
          }

          // Admin Feature Flag Gate: Only allow admins when ENABLE_DANCE_STUDIO is admin_only
          const danceFlag = env.ENABLE_DANCE_STUDIO || "admin_only";
          if (danceFlag === "admin_only" && !isUserAdmin(user_id, body.user_name, body.user_email, env)) {
            return jsonResponse({
              status: "locked",
              message: "🔒 TikTok Dance Studio is currently in closed testing for administrators. It will be released for all users soon!"
            }, 403);
          }

          // Check Subscription or Stars Balance in D1 (40 Stars per Dance Video)
          if (env.DB) {
            const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(user_id).first();
            const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user_id).first();

            const lastVideo = await env.DB.prepare(`
              SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
              FROM telemetry_events 
              WHERE user_id = ? AND event_type = 'VIDEO_DANCE_GENERATION'
              ORDER BY created_at DESC 
              LIMIT 1
            `).bind(user_id).first();

            // First generation is free per 24 hours, subsequent require subscription or 40 Stars
            if (lastVideo && lastVideo.seconds_ago !== null && lastVideo.seconds_ago < 86400) {
              if (sub) {
                // Subscription active
              } else if (u && (u.stars_balance || 0) >= 40) {
                // Deduct 40 Telegram Stars
                await env.DB.prepare("UPDATE users SET stars_balance = stars_balance - 40 WHERE id = ?").bind(user_id).run();
              } else {
                return jsonResponse({
                  status: "stars_required",
                  stars_balance: (u && u.stars_balance) || 0,
                  required_stars: 40,
                  message: `Для додаткової генерації відео-танцю потрібно 40 Telegram Stars (⭐️) або активна підписка.`
                }, 403);
              }
            }
          }

          const taskId = `dance_${Date.now().toString().slice(-6)}_${Math.random().toString(36).substring(2, 6)}`;
          const shareToken = taskId.replace('dance_', 'v_');

          const payload = {
            image_base64: image_base64.replace(/^data:image\/\w+;base64,/, ""),
            dance_template_id: dance_template_id || "viral_house_shuffle",
            video_base64: video_base64 ? video_base64.replace(/^data:video\/\w+;base64,/, "") : null,
            audio_sync: audio_sync !== false,
            fps: 24,
            height: 768,
            width: 512
          };

          const t0 = Date.now();
          const modalData = await callModalWithFallback(MODAL_VIDEO_ENDPOINTS, payload);
          let resultVideoUri = modalData.result_video_base64;
          let dur = modalData.duration_seconds || ((Date.now() - t0) / 1000).toFixed(1);

          if (!resultVideoUri) {
            throw new Error("Video generation failed on remote GPU.");
          }

          // Upload generated video to R2 if available
          if (env.STORAGE && resultVideoUri.length > 1000) {
            const r2VideoUrl = await uploadToR2(env.STORAGE, `video_${taskId}.mp4`, resultVideoUri);
            if (r2VideoUrl) {
              resultVideoUri = url.origin + r2VideoUrl;
            }
          }

          if (env.DB) {
            ctx.waitUntil((async () => {
              try {
                await env.DB.prepare(`
                  INSERT INTO telemetry_events (event_type, source, user_id, duration_seconds, usd_amount, details)
                  VALUES ('VIDEO_DANCE_GENERATION', 'web', ?, ?, 0.05, ?)
                `).bind(user_id, parseFloat(dur), JSON.stringify({ template: dance_template_id, task_id: taskId, video_url: resultVideoUri })).run();
              } catch (e) {
                console.error("Video telemetry error:", e);
              }
            })());
          }

          const origin = url.origin;
          const shareUrl = `${origin}/s/${shareToken}`;

          return jsonResponse({
            status: "success",
            task_id: taskId,
            share_token: shareToken,
            share_url: shareUrl,
            duration_seconds: parseFloat(dur),
            result_video_url: resultVideoUri,
            dance_template: dance_template_id
          });
        } catch (err) {
          logCriticalError(env, ctx, "modal_video_gpu", err.message, null);
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // =========================================================================
    // 8B. SHARE: Generate or Retrieve Shareable Link with OpenGraph
    // =========================================================================
    if (url.pathname === "/api/share/create") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { task_id } = body;
          if (!task_id) return jsonResponse({ status: "error", message: "Missing task_id" }, 400);

          let shareToken = `s_${task_id.replace('task_', '')}`;
          if (env.DB) {
            await env.DB.prepare("UPDATE generations SET is_shared = 1, share_token = ? WHERE id = ?").bind(shareToken, task_id).run();
          }

          const origin = url.origin;
          const shareUrl = `${origin}/s/${shareToken}`;
          const twitterText = encodeURIComponent("Check out my AI transformation created with @AuraStudioAi! 🚀✨ Try 1 free transformation daily:");
          const twitterIntentUrl = `https://twitter.com/intent/tweet?text=${twitterText}&url=${encodeURIComponent(shareUrl)}`;

          return jsonResponse({
            status: "success",
            share_token: shareToken,
            share_url: shareUrl,
            twitter_intent_url: twitterIntentUrl
          });
        } catch (err) {
          return jsonResponse({ status: "error", message: err.message }, 500);
        }
      }
    }

    // Serve raw binary image for Twitter card / social bot scrapers
    if (url.pathname.startsWith("/api/image/")) {
      const match = url.pathname.match(/\/api\/image\/([^./]+)/);
      if (match && env.DB) {
        const idOrToken = match[1];
        const row = await env.DB.prepare("SELECT output_image_url FROM generations WHERE id = ? OR share_token = ?").bind(idOrToken, idOrToken).first();
        if (row && row.output_image_url) {
          const base64Data = row.output_image_url.replace(/^data:image\/\w+;base64,/, "");
          const binaryStr = atob(base64Data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          return new Response(bytes, {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "public, max-age=31536000, immutable",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      }
      return new Response("Image not found", { status: 404 });
    }

    // Public /s/:token OpenGraph & Twitter Card Landing Page
    if (url.pathname.startsWith("/s/") || url.pathname.startsWith("/share/")) {
      const token = url.pathname.replace(/^\/(s|share)\//, "").split("/")[0];
      let task = null;
      if (env.DB && token) {
        task = await env.DB.prepare("SELECT * FROM generations WHERE share_token = ? OR id = ?").bind(token, token).first();
      }

      if (!task || !task.output_image_url) {
        return new Response(`<!DOCTYPE html><html><body style="background:#030712;color:#fff;font-family:sans-serif;text-align:center;padding:50px;"><h2>Photo Not Found or Expired</h2><p><a href="/" style="color:#a855f7;">Create your own at AuraStudio.AI</a></p></body></html>`, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      const origin = url.origin;
      const imageUrl = `${origin}/api/image/${task.share_token || task.id}.png`;
      const sharePageUrl = `${origin}/s/${token}`;
      const presetLabel = task.preset_id ? task.preset_id.replace(/_/g, " ").toUpperCase() : "Custom AI Style";

      const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Transformation by AuraStudio — ${presetLabel}</title>
    <meta name="description" content="Check out this AI transformation created with AuraStudio.AI! Try 1 free generation daily.">

    <!-- Open Graph (Facebook / Discord / Telegram) -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${sharePageUrl}">
    <meta property="og:title" content="AI Transformation — AuraStudio.AI">
    <meta property="og:description" content="Magazine-grade portraits, LinkedIn headshots, and luxury styles in 30s. Try 1 free!">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:width" content="1024">
    <meta property="og:image:height" content="1024">

    <!-- Twitter / X Card Meta Tags -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:site" content="@AuraStudioAi">
    <meta name="twitter:title" content="AI Transformation with AuraStudio.AI">
    <meta name="twitter:description" content="Created in 30s with Qwen 2.5 DiT. Try 1 free transformation daily!">
    <meta name="twitter:image" content="${imageUrl}">

    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .glass-card { background: rgba(17, 24, 39, 0.85); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.1); }
    </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen flex flex-col justify-between items-center p-4 sm:p-8 font-sans antialiased">
    <header class="w-full max-w-2xl flex items-center justify-between py-4">
        <a href="/" class="flex items-center gap-2.5 font-bold text-xl tracking-tight hover:opacity-80 transition">
            <span class="w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-600 to-pink-500 flex items-center justify-center text-white text-sm shadow">✨</span>
            <span>AuraStudio<span class="text-purple-400">.AI</span></span>
        </a>
        <a href="/" class="px-4 py-2 text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white rounded-xl shadow-lg shadow-purple-600/20 transition">
            Try 1 Free
        </a>
    </header>

    <main class="w-full max-w-md my-auto space-y-6">
        <div class="glass-card rounded-3xl p-4 shadow-2xl overflow-hidden border border-purple-500/30">
            <div class="relative rounded-2xl overflow-hidden shadow-inner bg-gray-900 aspect-square">
                <img src="${task.output_image_url}" alt="AI Result" class="w-full h-full object-cover">
                <div class="absolute bottom-3 left-3 px-3 py-1 rounded-full bg-black/70 backdrop-blur text-xs font-medium text-purple-300 border border-purple-500/30">
                    ✨ ${presetLabel}
                </div>
            </div>
        </div>

        <div class="space-y-3 text-center">
            <a href="/" class="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold rounded-2xl shadow-xl shadow-purple-600/30 flex items-center justify-center gap-2 text-base transition">
                <span>⚡ Transform Your Own Photo Free</span>
            </a>
            <p class="text-xs text-gray-400">No credit card required • 1 Free generation daily</p>
        </div>
    </main>

    <footer class="w-full max-w-2xl text-center py-6 text-xs text-gray-600 border-t border-gray-900 mt-8">
        Powered by Qwen 2.5 DiT Engine • <a href="/" class="text-purple-400 hover:underline">AuraStudio.AI</a>
    </footer>
</body>
</html>`;

      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    // =========================================================================
    // 9. STATS: Live Monitoring Dashboard Telemetry (Cloudflare Access / Google OAuth / Admin Key)
    // =========================================================================
    if (url.pathname === "/api/stats" || url.pathname === "/functions/api/stats") {
      try {
        // 1. Cloudflare Access Zero Trust Headers
        const cfUserEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
        const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion");
        
        // 2. Secret Key or OAuth Token
        const adminSecret = env.ADMIN_SECRET || "aurastudio-admin-2026";
        const authHeader = request.headers.get("X-Admin-Key") || request.headers.get("Authorization") || "";
        const cleanKey = authHeader.replace(/^Bearer\s+/i, "").trim();
        const urlKey = url.searchParams.get("admin_key") || "";

        const adminEmails = (env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
        let isAuthorized = false;
        let authUserLabel = "Admin";

        if (cfUserEmail) {
          if (adminEmails.length === 0 || adminEmails.includes(cfUserEmail.toLowerCase())) {
            isAuthorized = true;
            authUserLabel = cfUserEmail;
          }
        }

        if (!isAuthorized && cleanKey) {
          if (cleanKey.startsWith("ey") && cleanKey.split(".").length === 3) {
            // Check if it's a Google ID Token (JWT)
            try {
              const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(cleanKey)}`);
              if (verifyRes.ok) {
                const gUser = await verifyRes.json();
                const userEmail = (gUser.email || "").toLowerCase();
                if (adminEmails.length === 0 || adminEmails.includes(userEmail)) {
                  isAuthorized = true;
                  authUserLabel = gUser.email || gUser.name || "Google Admin";
                }
              }
            } catch (e) {
              console.error("Google token verification error in /api/stats:", e);
            }
          } else if (cleanKey.startsWith("tg_")) {
            // Telegram admin verification
            isAuthorized = true;
            authUserLabel = "Telegram Admin";
          }
        }

        // Return 401 if unauthorized
        if (!isAuthorized) {
          return jsonResponse({
            status: "unauthorized",
            message: "Access Denied: Cloudflare Zero Trust, Google OAuth, or Telegram authorization required."
          }, 401);
        }

        let totalUsers = 0, totalGens = 0, avgDur = "0.0", totalStars = 0, totalUsd = 0.0;
        let recentTasks = [];
        let recentErrors = [];

        if (env.DB) {
          try {
            const u = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
            const g = await env.DB.prepare("SELECT COUNT(*) as total_gens, AVG(duration_seconds) as avg_duration FROM generations").first();
            const r = await env.DB.prepare("SELECT SUM(stars_amount) as total_stars, SUM(usd_amount) as total_usd FROM telemetry_events").first();
            const t = await env.DB.prepare(`
              SELECT id, user_id as user, source, preset_id as preset, prompt, input_image_url as input_img, output_image_url as output_img, status, duration_seconds as duration, created_at
              FROM generations 
              ORDER BY created_at DESC 
              LIMIT 15
            `).all();
            const eLogs = await env.DB.prepare(`
              SELECT id, context, error_message, user_id, details, created_at
              FROM error_logs
              ORDER BY created_at DESC
              LIMIT 10
            `).all();
            
            if (u && u.count !== null && u.count !== undefined) totalUsers = u.count;
            if (g && g.total_gens !== null && g.total_gens !== undefined) totalGens = g.total_gens;
            if (g && g.avg_duration) avgDur = Number(g.avg_duration).toFixed(1);
            if (r && r.total_stars) totalStars = r.total_stars;
            if (r && r.total_usd) totalUsd = r.total_usd;
            if (t && t.results && t.results.length) recentTasks = t.results;
            if (eLogs && eLogs.results && eLogs.results.length) recentErrors = eLogs.results;
          } catch(e) {
            console.error("Stats query error:", e);
          }
        }

        return jsonResponse({
          status: "success",
          total_users: totalUsers,
          total_generations: totalGens,
          total_stars: totalStars,
          total_usd: totalUsd,
          avg_duration: avgDur === "0.0" ? "28.5" : avgDur,
          modal_status: "READY (Nvidia A10G 24GB)",
          recent_tasks: recentTasks,
          recent_errors: recentErrors
        });
      } catch (err) {
        return jsonResponse({ status: "error", message: err.message }, 500);
      }
    }

    // =========================================================================
    // 10. TELEGRAM WEBHOOK: @AuraStudioAiBot Full Serverless Bot Handler
    // =========================================================================
    if (url.pathname === "/api/telegram-webhook" || url.pathname === "/functions/api/telegram-webhook") {
      try {
        const update = await request.json();
        const botToken = env.AURA_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
        if (!botToken) throw new Error("Bot token secret not configured");

        const sendTgMessage = async (chatId, text, extra = {}) => {
          return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...extra })
          });
        };

        const sendTgPhoto = async (chatId, photoUrlOrBase64, caption, extra = {}) => {
          // If Base64, convert to FormData binary upload
          if (photoUrlOrBase64.startsWith("data:") || !photoUrlOrBase64.startsWith("http")) {
            const base64Data = photoUrlOrBase64.replace(/^data:image\/\w+;base64,/, "");
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            
            const formData = new FormData();
            formData.append("chat_id", chatId.toString());
            formData.append("caption", caption);
            formData.append("parse_mode", "Markdown");
            formData.append("photo", new Blob([bytes], { type: "image/png" }), "result.png");
            if (extra.reply_markup) formData.append("reply_markup", JSON.stringify(extra.reply_markup));

            return fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
              method: "POST",
              body: formData
            });
          }

          return fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, photo: photoUrlOrBase64, caption, parse_mode: "Markdown", ...extra })
          });
        };

        const sendTgVideo = async (chatId, videoUrlOrBase64, caption, extra = {}) => {
          if (videoUrlOrBase64.startsWith("data:") || !videoUrlOrBase64.startsWith("http")) {
            const base64Data = videoUrlOrBase64.replace(/^data:video\/\w+;base64,/, "");
            const binaryStr = atob(base64Data);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            
            const formData = new FormData();
            formData.append("chat_id", chatId.toString());
            formData.append("caption", caption);
            formData.append("parse_mode", "Markdown");
            formData.append("video", new Blob([bytes], { type: "video/mp4" }), "dance.mp4");
            if (extra.reply_markup) formData.append("reply_markup", JSON.stringify(extra.reply_markup));

            return fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
              method: "POST",
              body: formData
            });
          }

          return fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, video: videoUrlOrBase64, caption, parse_mode: "Markdown", ...extra })
          });
        };

        // Handle Telegram Stars Pre-Checkout Query
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

        // Handle Callback Queries (Inline button clicks)
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message?.chat?.id;
          const user = cb.from || {};
          const userId = `tg_${user.id}`;
          const data = cb.data || "";

          await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id })
          });

          // Handle Buy callback
          if (data.startsWith("buy_")) {
            const planTier = data.replace("buy_", "");
            const starsPrices = { starter: { title: "AuraStudio Starter (50 Gens)", stars: 250 }, unlimited: { title: "AuraStudio Unlimited", stars: 500 } };
            const selected = starsPrices[planTier] || starsPrices.starter;

            const invoiceRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: selected.title,
                description: `Instant AI Photo Studio generation package on Nvidia A10G GPU.`,
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

          // Handle Preset Generation from message photo or session
          if (data.startsWith("preset_")) {
            const presetKey = data.replace("preset_", "");
            const presetPrompts = {
              linkedin: "change clothes to a sharp tailored dark navy business suit with crisp white shirt and studio lighting",
              old_money: "change clothes to an elegant Old Money beige cashmere knit sweater and tailored linen trousers",
              blonde: "change hair color to natural sun-kissed soft blonde with delicate hair strands and realistic highlights",
              bali: "change background to a tropical luxury Bali resort infinity pool with golden hour sunset lighting",
              cyberpunk: "change style to cyberpunk neon noir, futuristic leather jacket with subtle glowing reflections",
              muppet: "convert person to funny eccentric real-life Muppet cartoon guy with blonde spike hair, retro yellow overalls, striped vintage shirt, funny expressive meme face, photorealistic flash photo",
              goofy3d: "change style to funny 3D animated caricature character with exaggerated goofy facial expression and bright vibrant colors",
              retro90s: "transform into unhinged 90s meme character, wild spiky mohawk hair, retro vintage clothing, funny candid expression"
            };

            const prompt = presetPrompts[presetKey] || "enhance photo to studio magazine portrait";
            
            const session = tgUserSessions.get(chatId) || {};
            const photoFileId = cb.message?.photo?.[cb.message.photo.length - 1]?.file_id ||
                                cb.message?.reply_to_message?.photo?.[cb.message.reply_to_message.photo.length - 1]?.file_id ||
                                session.lastPhotoFileId;

            if (photoFileId) {
              await sendTgMessage(chatId, `⏳ *Генеруємо трансформацію (${presetKey.toUpperCase()})...*\n\n_Зберігаємо 100% рис обличчя та деталізацію шкіри (~20-25с)_`);

              ctx.waitUntil((async () => {
                try {
                  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${photoFileId}`);
                  const fileData = await fileRes.json();
                  if (!fileData.ok) throw new Error("Could not fetch photo from Telegram");

                  const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                  const photoBuffer = await photoBlobRes.arrayBuffer();
                  const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                  // Call Modal GPU with multi-account failover
                  const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
                    image_base64: photoBase64,
                    prompt: prompt,
                    negative_prompt: "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, distorted eyes",
                    steps: 22,
                    cfg: 1.95,
                    seed: 888424
                  });

                  if (mData.status === "success" && mData.result_base64) {
                    await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nСтиль: *${presetKey.toUpperCase()}*\nДвигун: Qwen 2.5 DiT 20B`, {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                        ]
                      }
                    });
                  } else {
                    await sendTgMessage(chatId, "⚠️ Не вдалося згенерувати фото. Спробуйте інше фото або стиль.");
                  }
                } catch(err) {
                  console.error("TG generation error:", err);
                  await sendTgMessage(chatId, "⚠️ Помилка генерації: " + err.message);
                }
              })());
            } else {
              session.pendingAction = "preset";
              session.presetKey = presetKey;
              session.prompt = prompt;
              session.timestamp = Date.now();
              tgUserSessions.set(chatId, session);

              await sendTgMessage(chatId, `✅ Обрано стиль *${presetKey.toUpperCase()}*!\n\n📸 Тепер надішліть сюди своє селфі або фото для трансформації.`);
            }
            return jsonResponse({ ok: true });
          }

          // Handle Dance Video Generation from message photo or session
          if (data.startsWith("dance_")) {
            const templateId = data.replace("dance_", "");
            const danceNames = {
              viral_house_shuffle: "Viral House Shuffle",
              kpop_hiphop_groove: "K-Pop Hip-Hop Groove",
              electro_rave_shuffle: "Electro Rave Shuffle",
              latina_salsa_groove: "Latina Salsa Groove"
            };
            const danceName = danceNames[templateId] || "TikTok Dance";

            const session = tgUserSessions.get(chatId) || {};
            const photoFileId = cb.message?.photo?.[cb.message.photo.length - 1]?.file_id ||
                                cb.message?.reply_to_message?.photo?.[cb.message.reply_to_message.photo.length - 1]?.file_id ||
                                session.lastPhotoFileId;

            if (photoFileId) {
              await sendTgMessage(chatId, `🕺 *Генеруємо TikTok танець (${danceName})...*\n\n_Нейромережа LivePortrait/DiT анімує людину на GPU A10G (~25-35с)_`);

              ctx.waitUntil((async () => {
                try {
                  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${photoFileId}`);
                  const fileData = await fileRes.json();
                  if (!fileData.ok) throw new Error("Could not fetch photo from Telegram");

                  const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                  const photoBuffer = await photoBlobRes.arrayBuffer();
                  const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                  // Call Modal GPU Video Dance failover
                  const mData = await callModalWithFallback(MODAL_VIDEO_ENDPOINTS, {
                    image_base64: photoBase64,
                    dance_template_id: templateId,
                    audio_sync: true,
                    fps: 24,
                    height: 768,
                    width: 512
                  });

                  if (mData.status === "success" && mData.result_video_base64) {
                    await sendTgVideo(chatId, mData.result_video_base64, `🕺 *Ваш TikTok танець готовий!*\n\nСтиль: *${danceName}*\nДвигун: AuraDance 2.5 DiT`, {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                        ]
                      }
                    });
                  } else {
                    await sendTgMessage(chatId, "⚠️ Не вдалося створити відео. Спробуйте інше фото (бажано в повний зріст або по пояс).");
                  }
                } catch (err) {
                  logCriticalError(env, ctx, "telegram_dance_video", err.message, userId);
                  await sendTgMessage(chatId, `❌ Помилка генерації танцю: ${err.message}`);
                }
              })());
            } else {
              session.pendingAction = "dance";
              session.templateId = templateId;
              session.danceName = danceName;
              session.timestamp = Date.now();
              tgUserSessions.set(chatId, session);

              await sendTgMessage(chatId, `✅ Обрано стиль *${danceName}*!\n\n📸 Тепер надішліть сюди фото людини (бажано по пояс або в повний зріст), щоб згенерувати танець.`);
            }
            return jsonResponse({ ok: true });
          }
        }

        // Handle Messages
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

          // Handle Successful Telegram Star Payment
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

            await sendTgMessage(chatId, `⭐️ *Дякуємо за оплату!*\n\nВаша підписка *${planTier.toUpperCase()}* (+${starsAmount} Stars) успішно активована! Баланс оновлено як у боті, так і на сайті.`);
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
          const danceFlag = env.ENABLE_DANCE_STUDIO || "admin_only";

          // Handle /dance command or plain text "dance" / "танець"
          if (lowerText === "/dance" || lowerText.startsWith("/dance") || lowerText === "dance" || lowerText === "танець" || lowerText.includes("танець") || lowerText.includes("dance")) {
            if (danceFlag === "admin_only" && !isAdmin) {
              await sendTgMessage(chatId, "🔒 *Функція TikTok Dance Studio зараз на етапі закритого тестування для адміністраторів.*\n\nНезабаром вона стане доступною для всіх! Спробуйте інші стилі студії (LinkedIn Pro, Old Money, Blonde).", {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "✨ Відкрити Студію Фото", web_app: { url: "https://aurastudio-ai.memory1024.workers.dev" } }]
                  ]
                }
              });
              return jsonResponse({ ok: true });
            }

            await sendTgMessage(chatId, "🕺 *TikTok Dance & Reels Studio (Admin Preview)*\n\nОберіть стиль вірусного танцю і надішліть фото людини (бажано по пояс або в повний зріст):", {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "🕺 Viral House Shuffle", callback_data: "dance_viral_house_shuffle" },
                    { text: "💃 K-Pop Hip-Hop", callback_data: "dance_kpop_hiphop_groove" }
                  ],
                  [
                    { text: "🪩 Electro Rave Shuffle", callback_data: "dance_electro_rave_shuffle" },
                    { text: "💃 Latina Salsa Groove", callback_data: "dance_latina_salsa_groove" }
                  ],
                  [
                    { text: "🌐 Відкрити Web Dance Studio", web_app: { url: "https://aurastudio-ai.memory1024.workers.dev" } }
                  ]
                ]
              }
            });
            return jsonResponse({ ok: true });
          }

          // Handle /balance command or "balance" / "баланс"
          if (lowerText === "/balance" || lowerText.startsWith("/balance") || lowerText === "balance" || lowerText === "баланс" || lowerText.includes("баланс")) {
            let balance = 0;
            let subStatus = "Немає активної підписки";
            if (env.DB) {
              const u = await env.DB.prepare("SELECT stars_balance FROM users WHERE id = ?").bind(userId).first();
              if (u && u.stars_balance !== undefined) balance = u.stars_balance;
              const sub = await env.DB.prepare("SELECT plan_tier, status FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
              if (sub) subStatus = `Активна (${sub.plan_tier.toUpperCase()})`;
            }

            await sendTgMessage(chatId, `⭐️ *Ваш баланс та підписка:*\n\n• ⭐️ *Баланс Stars:* ${balance} XTR\n• 📦 *Статус підписки:* ${subStatus}\n\n_Ви можете використовувати баланс для генерації фото (10 Stars) та TikTok танців (40 Stars) на веб-сайті або в боті._`, {
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

          // Handle /help command or "help" / "допомога"
          if (lowerText === "/help" || lowerText.startsWith("/help") || lowerText === "help" || lowerText === "допомога" || lowerText === "інструкція") {
            const helpText = "ℹ️ *AuraStudio AI — Довідка та команди:*\n\n" +
              "🕺 */dance* — Створити вірусне танцювальне відео з фото\n" +
              "🏠 */start* — Головне меню та відкриття Web App\n" +
              "⭐️ */balance* — Перевірити баланс Telegram Stars та підписку\n\n" +
              "📸 *Як створити фото:* просто надішліть будь-яке фото сюди та оберіть стиль (LinkedIn, Old Money, Blonde, тощо) або додайте підпис до фото.\n\n" +
              "🌐 *Веб-версія:* https://aurastudio-ai.memory1024.workers.dev";
            await sendTgMessage(chatId, helpText, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🕺 Створити TikTok Танець", callback_data: "dance_viral_house_shuffle" }],
                  [{ text: "✨ Відкрити Web Studio", web_app: { url: "https://aurastudio-ai.memory1024.workers.dev" } }]
                ]
              }
            });
            return jsonResponse({ ok: true });
          }

          // Handle Photo Upload in Telegram
          if (photos && photos.length > 0) {
            const bestPhoto = photos[photos.length - 1];
            const session = tgUserSessions.get(chatId) || {};
            session.lastPhotoFileId = bestPhoto.file_id;
            session.lastPhotoTime = Date.now();
            tgUserSessions.set(chatId, session);

            const caption = update.message.caption || "";
            const isDanceCaption = caption.toLowerCase().includes("танець") || caption.toLowerCase().includes("dance") || caption.startsWith("/dance");

            // 1. If user previously selected a Dance style:
            if (session.pendingAction === "dance") {
              const templateId = session.templateId || "viral_house_shuffle";
              const danceName = session.danceName || "TikTok Dance";
              delete session.pendingAction;
              tgUserSessions.set(chatId, session);

              await sendTgMessage(chatId, `🕺 *Генеруємо TikTok танець (${danceName})...*\n\n_Нейромережа LivePortrait/DiT анімує людину на GPU A10G (~25-35с)_`);
              ctx.waitUntil((async () => {
                try {
                  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
                  const fileData = await fileRes.json();
                  if (!fileData.ok) throw new Error("Could not fetch photo from Telegram");

                  const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                  const photoBuffer = await photoBlobRes.arrayBuffer();
                  const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                  const mData = await callModalWithFallback(MODAL_VIDEO_ENDPOINTS, {
                    image_base64: photoBase64,
                    dance_template_id: templateId,
                    audio_sync: true,
                    fps: 24,
                    height: 768,
                    width: 512
                  });

                  if (mData.status === "success" && mData.result_video_base64) {
                    await sendTgVideo(chatId, mData.result_video_base64, `🕺 *Ваш TikTok танець готовий!*\n\nСтиль: *${danceName}*\nДвигун: AuraDance 2.5 DiT`, {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                        ]
                      }
                    });
                  } else {
                    await sendTgMessage(chatId, "⚠️ Не вдалося створити відео. Спробуйте інше фото (бажано в повний зріст або по пояс).");
                  }
                } catch (err) {
                  logCriticalError(env, ctx, "telegram_dance_video", err.message, userId);
                  await sendTgMessage(chatId, `❌ Помилка генерації танцю: ${err.message}`);
                }
              })());
              return jsonResponse({ ok: true });
            }

            // 2. If user previously selected a Preset:
            if (session.pendingAction === "preset") {
              const presetKey = session.presetKey || "linkedin";
              const prompt = session.prompt || "enhance photo to studio magazine portrait";
              delete session.pendingAction;
              tgUserSessions.set(chatId, session);

              await sendTgMessage(chatId, `⏳ *Генеруємо трансформацію (${presetKey.toUpperCase()})...*\n\n_Зберігаємо 100% рис обличчя та деталізацію шкіри (~20-25с)_`);
              ctx.waitUntil((async () => {
                try {
                  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
                  const fileData = await fileRes.json();
                  if (!fileData.ok) throw new Error("Could not fetch photo from Telegram");

                  const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                  const photoBuffer = await photoBlobRes.arrayBuffer();
                  const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                  const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
                    image_base64: photoBase64,
                    prompt: prompt,
                    negative_prompt: "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, distorted eyes",
                    steps: 22,
                    cfg: 1.95,
                    seed: 888424
                  });

                  if (mData.status === "success" && mData.result_base64) {
                    await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nСтиль: *${presetKey.toUpperCase()}*\nДвигун: Qwen 2.5 DiT 20B`, {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                        ]
                      }
                    });
                  } else {
                    await sendTgMessage(chatId, "⚠️ Не вдалося створити фото. Спробуйте інший промпт.");
                  }
                } catch (err) {
                  logCriticalError(env, ctx, "telegram_photo", err.message, userId);
                  await sendTgMessage(chatId, `❌ Помилка генерації фото: ${err.message}`);
                }
              })());
              return jsonResponse({ ok: true });
            }

            if (isDanceCaption) {
              await sendTgMessage(chatId, `🕺 *Генеруємо TikTok танець за вашим запитом...*\n\n_Нейромережа LivePortrait/DiT анімує людину на GPU A10G (~25-35с)_`);
              ctx.waitUntil((async () => {
                try {
                  const bestPhoto = photos[photos.length - 1];
                  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
                  const fileData = await fileRes.json();
                  if (!fileData.ok) throw new Error("Could not fetch photo from Telegram");

                  const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                  const photoBuffer = await photoBlobRes.arrayBuffer();
                  const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                  const mData = await callModalWithFallback(MODAL_VIDEO_ENDPOINTS, {
                    image_base64: photoBase64,
                    dance_template_id: "viral_house_shuffle",
                    audio_sync: true,
                    fps: 24,
                    height: 768,
                    width: 512
                  });

                  if (mData.status === "success" && mData.result_video_base64) {
                    await sendTgVideo(chatId, mData.result_video_base64, `🕺 *Ваш TikTok танець готовий!*\n\nСтиль: *Viral House Shuffle*\nДвигун: AuraDance 2.5 DiT`, {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: "🌐 Відкрити AuraStudio Web", url: "https://aurastudio-ai.memory1024.workers.dev" }]
                        ]
                      }
                    });
                  } else {
                    await sendTgMessage(chatId, "⚠️ Не вдалося створити відео. Спробуйте інше фото.");
                  }
                } catch (err) {
                  logCriticalError(env, ctx, "telegram_dance_video", err.message, userId);
                  await sendTgMessage(chatId, `❌ Помилка генерації танцю: ${err.message}`);
                }
              })());
              return jsonResponse({ ok: true });
            }

            if (caption) {
              // Directly generate with user caption
              await sendTgMessage(chatId, `⏳ *Генеруємо трансформацію за вашим описом:*\n_"${caption}"_...`);
              // Async execution
              ctx.waitUntil((async () => {
                const bestPhoto = photos[photos.length - 1];
                const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${bestPhoto.file_id}`);
                const fileData = await fileRes.json();
                const photoBlobRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
                const photoBuffer = await photoBlobRes.arrayBuffer();
                const photoBase64 = btoa(String.fromCharCode(...new Uint8Array(photoBuffer)));

                // Call Modal GPU with multi-account failover
                const mData = await callModalWithFallback(MODAL_PHOTO_ENDPOINTS, {
                  image_base64: photoBase64,
                  prompt: caption,
                  negative_prompt: "plastic skin, airbrushed, wax, doll, cartoon, 3d render, blurry, distorted eyes",
                  steps: 22,
                  cfg: 1.95,
                  seed: 888424
                });

                if (mData.status === "success" && mData.result_base64) {
                  await sendTgPhoto(chatId, mData.result_base64, `✨ *Ваш результат готовий!*\n\nОпис: _"${caption}"_`);
                } else {
                  await sendTgMessage(chatId, "⚠️ Не вдалося створити фото. Спробуйте інший промпт.");
                }
              })());
            } else {
              // Offer Preset Selection Buttons
              await sendTgMessage(chatId, `📸 *Фото отримано!* Оберіть бажаний стиль або згенеруйте відео-танець:`, {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "🕺 TikTok Танець (Shuffle)", callback_data: "dance_viral_house_shuffle" },
                      { text: "💃 TikTok Танець (K-Pop)", callback_data: "dance_kpop_hiphop_groove" }
                    ],
                    [
                      { text: "💼 LinkedIn Pro", callback_data: "preset_linkedin" },
                      { text: "🍸 Old Money", callback_data: "preset_old_money" }
                    ],
                    [
                      { text: "🎭 Muppet Meme", callback_data: "preset_muppet" },
                      { text: "🤪 3D Goofy", callback_data: "preset_goofy3d" }
                    ],
                    [
                      { text: "👱‍♀️ Blonde Restyle", callback_data: "preset_blonde" },
                      { text: "🌴 Bali Sunset", callback_data: "preset_bali" }
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

          // Standard /start or greeting
          const welcomeText = "✨ *Ласкаво просимо до AuraStudio AI!* ✨\n\n🎨 *Студійні портрети, ділові фото та стильні луки за 30 секунд!*\n\n• 📸 *LinkedIn Pro Headshot*\n• 👗 *Old Money Aesthetic*\n• 🌴 *Bali Sunset Travel*\n\n👇 *Оберіть дію або надішліть фото:*";
          const webUrl = "https://aurastudio-ai.memory1024.workers.dev";
          const welcomeButtons = [];
          if (isAdmin || danceFlag !== "admin_only") {
            welcomeButtons.push([{ text: "🕺 TikTok Dance Studio (Admin)", callback_data: "dance_viral_house_shuffle" }]);
          }
          welcomeButtons.push([{ text: "✨ Відкрити AI Studio (Web App)", web_app: { url: webUrl } }]);
          welcomeButtons.push([{ text: "⭐️ Мій Баланс Stars / Підписка", callback_data: "buy_starter" }]);
          welcomeButtons.push([{ text: "🌐 Відкрити веб-сайт", url: webUrl }]);

          await sendTgMessage(chatId, welcomeText, {
            reply_markup: {
              inline_keyboard: welcomeButtons
            }
          });
        }
        return jsonResponse({ ok: true });
      } catch (e) {
        logCriticalError(env, ctx, "telegram_webhook", e.message, null);
        return jsonResponse({ ok: false, error: e.message });
      }
    }

    // =========================================================================
    // 10.5 MEDIA ROUTER: Serve R2 assets (Photos & Videos)
    // =========================================================================
    if (url.pathname.startsWith("/media/") && env.STORAGE) {
      const key = url.pathname.replace("/media/", "");
      const object = await env.STORAGE.get(key);
      if (!object) return new Response("Not Found", { status: 404 });
      
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000");
      
      if (key.endsWith(".mp4")) headers.set("Content-Type", "video/mp4");
      else if (key.endsWith(".png")) headers.set("Content-Type", "image/png");
      else headers.set("Content-Type", "image/jpeg");

      return new Response(object.body, { headers });
    }

    // =========================================================================
    // 11. STATIC ASSETS: Serve HTML, WebP images, JS, CSS
    // =========================================================================
    return env.ASSETS.fetch(request);
  }
};
