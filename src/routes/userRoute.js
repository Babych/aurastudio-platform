// Route Handler: Public Config, Feedback, User Profiles, Auth & Payments

import { jsonResponse } from "../utils/response.js";
import { DAILY_FREE_GENERATIONS_LIMIT } from "../config/constants.js";
import { authSessions, isUserAdmin } from "../services/dbService.js";

export async function handleConfig(request, env, url) {
  return jsonResponse({
    status: "success",
    google_client_id: env.GOOGLE_CLIENT_ID || "",
    telegram_bot_username: env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot",
    telegram_only_payments: env.TELEGRAM_ONLY_PAYMENTS !== "false",
    environment: env.ENVIRONMENT || "production"
  });
}

export async function handleFeedback(request, env, url) {
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

  return jsonResponse({ error: "Method not allowed" }, 405);
}

export async function handleAuthGoogle(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const { credential } = body;

    if (!credential) {
      return jsonResponse({ status: "error", message: "Missing Google ID token" }, 400);
    }

    let googleUser = null;
    try {
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if (verifyRes.ok) {
        googleUser = await verifyRes.json();
      }
    } catch (e) {
      console.error("Google tokeninfo error:", e);
    }

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

export async function handleAuthTelegram(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
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

export async function handleAuthTelegramSession(request, env, url) {
  const sessionCode = `auth_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  authSessions.set(sessionCode, { status: "pending", expiresAt, user: null });

  const botUsername = env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot";
  const deepLink = `https://t.me/${botUsername}?start=${sessionCode}`;

  return jsonResponse({
    status: "success",
    session_code: sessionCode,
    bot_username: botUsername,
    deep_link: deepLink,
    expires_at: expiresAt
  });
}

export async function handleAuthTelegramPoll(request, env, url) {
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

export async function handleUserProfile(request, env, url) {
  const userId = url.searchParams.get("user_id");
  if (!userId) {
    return jsonResponse({ status: "error", message: "Missing user_id" }, 400);
  }

  // Handle Guest Profile
  if (userId.startsWith("guest_")) {
    let guestUsed = 0;
    let recentGens = [];
    if (env.DB) {
      const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("x-real-ip") || "";
      const ipPattern = clientIp ? `%${clientIp.replace(/[^a-zA-Z0-9]/g, "_")}%` : userId;
      const countRow = await env.DB.prepare(`
        SELECT COUNT(*) as count 
        FROM generations 
        WHERE (user_id = ? OR user_id LIKE ?) AND status = 'SUCCESS'
      `).bind(userId, ipPattern).first();
      guestUsed = (countRow && countRow.count) || 0;

      const gens = await env.DB.prepare("SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").bind(userId).all();
      recentGens = (gens && gens.results) || [];
    }
    const guestRemaining = Math.max(0, 1 - guestUsed);
    return jsonResponse({
      status: "success",
      user: { id: userId, name: "Guest User", free_generations_used: guestUsed, is_guest: true },
      is_admin: false,
      is_guest: true,
      stars_balance: 0,
      daily_limit: 1,
      free_used_today: guestUsed,
      free_remaining: guestRemaining,
      hours_left: 0,
      can_generate: guestRemaining > 0,
      subscription: null,
      history: recentGens
    });
  }

  if (env.DB) {
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").bind(userId).first();
    const recentGens = await env.DB.prepare("SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 12").bind(userId).all();

    const isAdmin = isUserAdmin(userId, u ? u.username : null, u ? u.email : null, env);
    if (isAdmin) {
      return jsonResponse({
        status: "success",
        user: u || { id: userId, free_generations_used: 0, stars_balance: 999 },
        is_admin: true,
        stars_balance: (u && u.stars_balance) || 999,
        daily_limit: 999,
        free_used_today: 0,
        free_remaining: 999,
        hours_left: 0,
        can_generate: true,
        subscription: sub || { plan_tier: "admin_unlimited", status: "active" },
        history: (recentGens && recentGens.results) || []
      });
    }

    const dailyCountRow = await env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM generations 
      WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
    `).bind(userId).first();

    const freeUsedToday = (dailyCountRow && dailyCountRow.count) || 0;
    const freeRemainingToday = Math.max(0, DAILY_FREE_GENERATIONS_LIMIT - freeUsedToday);

    let hoursLeft = 0;
    if (freeUsedToday >= DAILY_FREE_GENERATIONS_LIMIT) {
      const fifthGen = await env.DB.prepare(`
        SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
        FROM generations
        WHERE user_id = ? AND status = 'SUCCESS' AND (strftime('%s', 'now') - strftime('%s', created_at)) < 86400
        ORDER BY created_at DESC
        LIMIT 1 OFFSET ?
      `).bind(userId, DAILY_FREE_GENERATIONS_LIMIT - 1).first();

      if (fifthGen && fifthGen.seconds_ago !== null) {
        hoursLeft = Math.max(1, Math.ceil((86400 - fifthGen.seconds_ago) / 3600));
      }
    }

    const starsBalance = (u && u.stars_balance) || 0;
    const hasPaidAccess = !!sub || starsBalance >= 10;

    return jsonResponse({
      status: "success",
      user: u || { id: userId, free_generations_used: 0, stars_balance: 0 },
      is_admin: false,
      stars_balance: starsBalance,
      daily_limit: DAILY_FREE_GENERATIONS_LIMIT,
      free_used_today: freeUsedToday,
      free_remaining: freeRemainingToday,
      hours_left: hoursLeft,
      can_generate: (freeRemainingToday > 0) || hasPaidAccess,
      subscription: sub || null,
      history: (recentGens && recentGens.results) || []
    });
  }

  const isAdmin = isUserAdmin(userId, null, null, env);
  return jsonResponse({
    status: "success",
    user: { id: userId, free_generations_used: 0, stars_balance: isAdmin ? 999 : 0 },
    is_admin: isAdmin,
    stars_balance: isAdmin ? 999 : 0,
    daily_limit: isAdmin ? 999 : DAILY_FREE_GENERATIONS_LIMIT,
    free_used_today: 0,
    free_remaining: isAdmin ? 999 : DAILY_FREE_GENERATIONS_LIMIT,
    hours_left: 0,
    can_generate: true,
    subscription: isAdmin ? { plan_tier: "admin_unlimited", status: "active" } : null,
    history: []
  });
}

export async function handlePaymentsCheckout(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
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

export async function handlePaymentsStars(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
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

    const invoiceRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: selected.title,
        description: `Instant AI Photo Studio generation package on Nvidia L40S GPU.`,
        payload: JSON.stringify({ user_id: user_id || `tg_${chat_id}`, plan_tier }),
        currency: "XTR",
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

    const botUser = env.TELEGRAM_BOT_USERNAME || "thing_intellect_bot";
    return jsonResponse({
      status: "success",
      invoice_url: `https://t.me/${botUser}?start=buy_${plan_tier}`
    });
  } catch (err) {
    return jsonResponse({ status: "error", message: err.message }, 500);
  }
}

export async function handlePaymentsWebhook(request, env, url) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
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
