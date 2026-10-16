# 🎨 AuraStudio AI — Full-Stack Serverless Generative AI Platform

> **Magazine-grade portraits, ultra-realistic skin synthesis, and luxury styling powered by Qwen 2.5 DiT Diffusion Transformer, Cloudflare Serverless Edge, and Telegram Stars Monetization.**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-aurastudio--ai-8b5cf6?style=for-the-badge&logo=cloudflare&logoColor=white)](https://aurastudio-ai.memory1024.workers.dev/)
[![Telemetry Dashboard](https://img.shields.io/badge/Telemetry-Admin%20Dashboard-10b981?style=for-the-badge&logo=statuspage&logoColor=white)](https://aurastudio-ai.memory1024.workers.dev/dashboard)
[![Telegram Bot](https://img.shields.io/badge/Telegram-@AuraStudioAiBot-229ED9?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/AuraStudioAiBot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph CLIENTS ["🌐 Multi-Platform Client Layer"]
        WEB["💻 Web Portal (Tailwind CSS + Stars Live Balance)"]
        TG_APP["📱 Telegram Mini App (TMA SDK)"]
        TG_BOT["🤖 Telegram Bot Client (@AuraStudioAiBot: style presets)"]
        SOCIAL["🐦 Twitter / X Viral Share Landing (/s/:token)"]
    end

    subgraph EDGE ["⚡ Cloudflare Edge Network (Global Serverless)"]
        WORKER["🛡️ Cloudflare Worker API Gateway (src/worker.js)"]
        D1[("🗄️ Cloudflare D1 Database (Edge SQLite: Users, Logs, Quotas)")]
        R2[("📦 Cloudflare R2 Object Storage (Photos & Generated Assets)")]
        AUTH["🔑 Auth Engine (Google GIS OAuth + TG Session Poll + Identity Merge)"]
        BILLING["⭐️ Telegram Stars Engine (TELEGRAM_ONLY_PAYMENTS)"]
        CARDS["🖼️ Dynamic Twitter Card / OpenGraph Generator"]
    end

    subgraph AI_CORE ["🔒 Serverless GPU Compute Engine (Modal Cloud Dual-Pool)"]
        MODAL_PRI["⚡ Primary Modal Endpoint (dmytrobbch: Nvidia L40S/A10G)"]
        MODAL_SEC["🔄 Secondary Modal Endpoint (memory1024: Failover Pool)"]
        DIT["🧬 Qwen 2.5 DiT 20B (FP8 Photo Transform)"]
    end

    CLIENTS --> WORKER
    WORKER --> D1
    WORKER --> R2
    WORKER --> AUTH
    WORKER --> BILLING
    WORKER --> CARDS
    WORKER -- "Automatic Failover (callModalWithFallback)" --> MODAL_PRI
    MODAL_PRI -. "On 402/429/5xx / Out of Credits" .-> MODAL_SEC
    MODAL_PRI --> DIT
```

---

## ✨ Core Features & Technical Highlights

### 1. 💎 Ultra-Realistic Portrait Restyling & Macro Skin (Qwen 2.5 DiT)
- **100% Facial Identity Retention**: Holistic DiT latent synthesis preserving eyes, gaze, expression, and natural skin micro-pores.
- **Studio Presets**: LinkedIn Business Pro, Old Money Luxury, Blonde Restyle, Bali Sunset, and custom text prompt editing.
- **Native Telegram Bot Integration**: Send any photo to the bot or use inline preset buttons.

### 2. ⚡ Dual-Account Modal GPU Failover ($30 + $11 Balance Pools)
- **Zero-Downtime Multi-Workspace Routing**: Cloudflare Worker uses `callModalWithFallback` to automatically switch between primary (`dmytrobbch` - $30) and secondary (`memory1024` - $11) GPU workspaces upon error or credit exhaustion.
- **Aggressive Cost Optimization**: GPU `scaledown_window` tuned to **45 seconds**, reducing isolated lifecycle cost to **~$0.02** (~80 kopiykas) per generation.

### 3. ⭐️ Unified Telegram Stars Monetization & Identity Merge
- **`TELEGRAM_ONLY_PAYMENTS: true`**: Frictionless 1-click mobile checkout via Telegram Stars without banking or merchant bureaucracy.
- **Cross-Platform Identity Merging**: Users signed in via Google on the Web can pay with Telegram Stars; payments are automatically linked and credited to their Web account.
- **Real-Time Balance Badge**: Header displays live `⭐ 250 Stars` balance synced with Cloudflare D1.
- **Quota Model**: 5 free photos/videos per day (rolling 24h); additional photo = **10 Stars**, video = **40 Stars**.

### 4. 🗄️ Resilient Edge Database & Media Storage (D1 + R2)
- **Cloudflare D1**: Persistent tables for `users`, `generations`, `telemetry_events`, and `error_logs`.
- **Cloudflare R2 (`aurastudio-media`)**: Large images and video files stored with fast global CDN caching via `/media/*`.

### 5. 🔒 Secured Visual Telemetry Dashboard
- **Live Business Analytics**: Real-time stats on total users, generation volume, Stars balance, and error logs (`/dashboard`).
- **Critical Error Logging**: `logCriticalError` captures GPU and webhook exceptions into D1 silently.

---

## 📂 Project Structure

```text
aurastudio-platform/
├── src/
│   └── worker.js             # Cloudflare Edge Worker API Gateway, Failover & Telegram Webhook
├── modal/
│   └── modal_qwen_service.py # Modal GPU Serverless Qwen 2.5 DiT Photo Restyling Engine
├── web/
│   ├── index.html            # Main Web Studio (Tailwind CSS + GIS + Presets)
│   ├── dashboard.html        # Real-time Telemetry & Critical Error Log Dashboard
│   ├── schema.sql            # Cloudflare D1 Database Relational Schema
│   └── assets/presets/       # Synthetic AI Style Presets
├── .agents/
│   └── skills/               # Antigravity Persistent Agent Architecture Skills
├── .github/
│   └── workflows/
│       └── deploy.yml        # Automated CI/CD (Cloudflare Edge + Dual Modal GPU Deploy)
├── wrangler.jsonc            # Cloudflare Worker, D1 & R2 Configuration
├── requirements.txt          # Python dependencies
└── README.md                 # Complete system documentation & runbook
```

---

## 🚀 Deployment & CI/CD Runbook

The platform uses automated GitHub Actions CI/CD (`.github/workflows/deploy.yml` on `ubuntu-latest`):

### GitHub Actions Secrets:
* `CLOUDFLARE_ACCOUNT_ID`: `da9d897a45e91c7e95572db2423e01fa`
* `CLOUDFLARE_API_TOKEN`: Cloudflare Workers & Pages API token
* `MODAL_TOKEN_ID` & `MODAL_TOKEN_SECRET`: Primary Modal account (`dmytrobbch`)
* `MODAL_TOKEN_ID_SECONDARY` & `MODAL_TOKEN_SECRET_SECONDARY`: Secondary Modal account (`memory1024`)

### Manual CLI Commands:
```bash
# Deploy Cloudflare Edge & Static Assets
npx wrangler deploy

# Deploy Modal Cloud GPU Qwen DiT Engine
python -m modal deploy modal/modal_qwen_service.py

# Apply Database Migrations to Cloudflare D1
npx wrangler d1 execute aurastudio-prod-db --file=web/schema.sql --remote
```
