// Cloudflare Worker: AuraStudio AI Enterprise Edge Platform
// Modular Router: Clean separation of concerns across Config, Services, and Route Handlers

import { CORS_HEADERS } from "./config/constants.js";
import { 
  handleConfig, 
  handleFeedback, 
  handleAuthGoogle, 
  handleAuthTelegram, 
  handleAuthTelegramSession, 
  handleAuthTelegramPoll, 
  handleUserProfile, 
  handlePaymentsCheckout, 
  handlePaymentsStars, 
  handlePaymentsWebhook 
} from "./routes/userRoute.js";
import { 
  handleGenerate, 
  handleQueueStatus, 
  handleTaskStatus, 
  handleShareCreate 
} from "./routes/generateRoute.js";
import { 
  handleShareImage, 
  handleSharePage 
} from "./routes/shareRoute.js";
import { 
  handleStats, 
  handleSmokeTest 
} from "./routes/statsRoute.js";
import { 
  handleTelegramDebug, 
  handleTelegramWebhook 
} from "./routes/telegramRoute.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 2. Configuration & Feedback
    if (url.pathname === "/api/config") {
      return handleConfig(request, env, url);
    }
    if (url.pathname === "/api/feedback") {
      return handleFeedback(request, env, url);
    }

    // 3. User Authentication
    if (url.pathname === "/api/auth/google") {
      return handleAuthGoogle(request, env, url);
    }
    if (url.pathname === "/api/auth/telegram") {
      return handleAuthTelegram(request, env, url);
    }
    if (url.pathname === "/api/auth/telegram-session") {
      return handleAuthTelegramSession(request, env, url);
    }
    if (url.pathname === "/api/auth/telegram-poll") {
      return handleAuthTelegramPoll(request, env, url);
    }

    // 4. User Profile & Quotas
    if (url.pathname === "/api/user/profile") {
      return handleUserProfile(request, env, url);
    }

    // 5. Payments (Stripe & Telegram Stars)
    if (url.pathname === "/api/payments/create-checkout-session") {
      return handlePaymentsCheckout(request, env, url);
    }
    if (url.pathname === "/api/payments/create-stars-invoice") {
      return handlePaymentsStars(request, env, url);
    }
    if (url.pathname === "/api/payments/webhook") {
      return handlePaymentsWebhook(request, env, url);
    }

    // 6. AI Generation & Queue Telemetry
    if (url.pathname === "/api/queue-status" || url.pathname === "/functions/api/queue-status") {
      return handleQueueStatus(request, env, url);
    }
    if (url.pathname.startsWith("/api/task-status/")) {
      return handleTaskStatus(request, env, url);
    }
    if (url.pathname === "/api/generate" || url.pathname === "/functions/api/generate") {
      return handleGenerate(request, env, ctx, url);
    }

    // 7. Social Sharing & Media Proxy
    if (url.pathname === "/api/share/create") {
      return handleShareCreate(request, env, url);
    }
    if (url.pathname.startsWith("/api/image/")) {
      return handleShareImage(request, env, url);
    }
    if (url.pathname.startsWith("/s/") || url.pathname.startsWith("/share/")) {
      return handleSharePage(request, env, url);
    }

    // 8. Monitoring Dashboard & Smoke Testing
    if (url.pathname === "/api/stats" || url.pathname === "/functions/api/stats") {
      return handleStats(request, env, url);
    }
    if (url.pathname === "/api/smoke-test" || url.pathname === "/functions/api/smoke-test") {
      return handleSmokeTest(request, env, url);
    }

    // 9. Telegram Bot Integration
    if (url.pathname === "/api/telegram-debug") {
      return handleTelegramDebug(request, env, url);
    }
    if (url.pathname === "/api/telegram-webhook" || url.pathname === "/functions/api/telegram-webhook") {
      return handleTelegramWebhook(request, env, ctx, url);
    }

    // 10. R2 Storage Media CDN
    if (url.pathname.startsWith("/media/") && env.STORAGE) {
      const key = url.pathname.replace("/media/", "");
      const object = await env.STORAGE.get(key);
      if (!object) return new Response("Not Found", { status: 404 });
      
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(object.body, { headers });
    }

    // 11. Static Frontend Assets Fallback
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
