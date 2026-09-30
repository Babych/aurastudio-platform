-- ==========================================================
-- Cloudflare D1 Database Schema for AuraStudio AI & Dashboards
-- ==========================================================

-- 1. Users table (Web + Telegram users)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,               -- UUID or Telegram ID
    email TEXT UNIQUE,
    username TEXT,
    name TEXT,
    avatar_url TEXT,
    auth_provider TEXT DEFAULT 'google', -- 'google', 'telegram', 'email'
    stars_balance INTEGER DEFAULT 0,
    free_generations_used INTEGER DEFAULT 0,
    bonus_generations INTEGER DEFAULT 0,
    total_generations INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Stripe Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,                 -- Stripe Sub ID (sub_...)
    user_id TEXT NOT NULL REFERENCES users(id),
    stripe_customer_id TEXT NOT NULL,
    plan_tier TEXT NOT NULL,             -- 'starter', 'unlimited', 'business'
    status TEXT NOT NULL,                -- 'active', 'past_due', 'canceled'
    current_period_start TIMESTAMP,
    current_period_end TIMESTAMP,
    cancel_at_period_end BOOLEAN DEFAULT 0,
    monthly_credits_limit INTEGER DEFAULT 50,
    credits_used_this_period INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Unified Generation & Task Journal
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,                 -- Task UUID
    user_id TEXT NOT NULL REFERENCES users(id),
    source TEXT DEFAULT 'web',           -- 'web', 'telegram_prod', 'telegram_dev'
    preset_id TEXT,
    prompt TEXT,
    input_image_url TEXT NOT NULL,
    output_image_url TEXT,
    status TEXT DEFAULT 'PENDING',       -- 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'
    duration_seconds REAL,
    stars_cost INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Real-time Telemetry & Ingested Events
CREATE TABLE IF NOT EXISTS telemetry_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,           -- 'GENERATION_SUCCESS', 'GENERATION_FAILED', 'STARS_PURCHASE', 'STRIPE_SUBSCRIPTION'
    source TEXT NOT NULL,               -- 'telegram_bot', 'creative_bot', 'web'
    user_id TEXT,
    duration_seconds REAL,
    stars_amount INTEGER DEFAULT 0,
    usd_amount REAL DEFAULT 0.0,
    details JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lightning fast dashboard analytics
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_gens_user ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_gens_created ON generations(created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_events(created_at);
