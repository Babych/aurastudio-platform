"""
Telegram Creative AI Studio & Magic Photo Editor Bot
Powered by Qwen 2.5 DiT 20B (Diffusion Transformer on Serverless Cloud GPU)
Author: AuraStudio AI Team
"""

import os
import sys
import time
import json
import base64
import asyncio
import urllib.parse
import aiosqlite
import requests
from io import BytesIO
from PIL import Image, ImageFilter, ImageDraw, ImageEnhance
from dotenv import load_dotenv

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardRemove,
    BotCommand,
    LabeledPrice,
    MenuButtonCommands
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    PreCheckoutQueryHandler,
    ContextTypes,
    filters
)

# Load environment variables
load_dotenv()

# Dev Mode Flag
IS_DEV_MODE = "--dev" in sys.argv or os.getenv("DEV_MODE", "0") == "1"

# Bot Token
if IS_DEV_MODE:
    BOT_TOKEN = os.getenv("DEV_BOT_TOKEN", os.getenv("CREATIVE_BOT_TOKEN", ""))
    print(f"[*] 🧪 DEV MODE ACTIVE — Using Dev Bot Token ({BOT_TOKEN[:10]}...)")
else:
    BOT_TOKEN = os.getenv("CREATIVE_BOT_TOKEN", os.getenv("BOT_TOKEN", ""))

MODAL_ENDPOINT_URL = os.getenv("MODAL_ENDPOINT_URL", "")

# Super Admin IDs & Usernames (strictly from .env)
raw_super_ids = os.getenv("SUPER_ADMIN_IDS", os.getenv("SUPER_ADMIN_ID", ""))
SUPER_ADMIN_IDS = [int(x.strip()) for x in raw_super_ids.split(",") if x.strip().isdigit()]

raw_super_usernames = os.getenv("SUPER_ADMIN_USERNAMES", "")
SUPER_ADMIN_USERNAMES = [u.strip().lstrip("@").lower() for u in raw_super_usernames.split(",") if u.strip()]

def is_super_admin(user_id: int, username: str = "") -> bool:
    if user_id in SUPER_ADMIN_IDS:
        return True
    if username and username.lstrip("@").lower() in SUPER_ADMIN_USERNAMES:
        return True
    return False

# Storage Directories
_default_base = r"D:\AI_Workspace\ComfyUI\creative_bot_temp" if os.path.exists(r"D:\AI_Workspace") else os.path.abspath("creative_bot_temp")
BASE_STORAGE = os.getenv("STORAGE_PATH", _default_base)
if IS_DEV_MODE:
    BASE_STORAGE = os.path.join(os.path.dirname(BASE_STORAGE), "creative_bot_dev_temp")

INPUT_STORAGE = os.path.join(BASE_STORAGE, "inputs")
OUTPUT_STORAGE = os.path.join(BASE_STORAGE, "outputs")
os.makedirs(INPUT_STORAGE, exist_ok=True)
os.makedirs(OUTPUT_STORAGE, exist_ok=True)

DB_PATH = os.path.join(BASE_STORAGE, "creative_bot.db")

# Pricing & Free Limits
PRICE_STARS = int(os.getenv("CREATIVE_PRICE_STARS", "10"))
FREE_GENERATIONS_LIMIT = int(os.getenv("CREATIVE_FREE_LIMIT", "3"))
TELEMETRY_STREAM_ENABLED = True
LAST_GENERATION_DURATION = 55.0

# Socket Mutex Lock to Prevent Duplicate Instances
SINGLE_INSTANCE_PORT = 49169 if IS_DEV_MODE else int(os.getenv("CREATIVE_PORT_LOCK", "49160"))
LOCK_SOCKET = None

def acquire_single_instance_lock():
    global LOCK_SOCKET
    import socket
    try:
        LOCK_SOCKET = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        LOCK_SOCKET.bind(('127.0.0.1', SINGLE_INSTANCE_PORT))
        LOCK_SOCKET.listen(1)
        return True
    except socket.error:
        print(f"[!] Another instance of Creative AI Bot ({'DEV' if IS_DEV_MODE else 'PROD'}) is already running on port {SINGLE_INSTANCE_PORT}!")
        return False

# ==================== Database Schema ====================
async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                language TEXT DEFAULT 'uk',
                free_generations_used INTEGER DEFAULT 0,
                stars_balance INTEGER DEFAULT 0,
                total_generations INTEGER DEFAULT 0,
                referrer_id INTEGER DEFAULT NULL,
                referred_count INTEGER DEFAULT 0,
                bonus_generations INTEGER DEFAULT 0,
                created_at REAL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS task_journal (
                task_id TEXT PRIMARY KEY,
                user_id INTEGER,
                input_path TEXT,
                prompt TEXT,
                category TEXT,
                status TEXT DEFAULT 'PENDING',
                is_free INTEGER DEFAULT 1,
                created_at REAL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_sessions (
                user_id INTEGER PRIMARY KEY,
                current_task_id TEXT,
                waiting_for_prompt INTEGER DEFAULT 0,
                updated_at REAL
            )
        """)
        await db.commit()

        # Ensure safe column migrations for existing databases
        for col_def in [
            "referrer_id INTEGER DEFAULT NULL",
            "referred_count INTEGER DEFAULT 0",
            "bonus_generations INTEGER DEFAULT 0"
        ]:
            try:
                await db.execute(f"ALTER TABLE users ADD COLUMN {col_def}")
                await db.commit()
            except Exception:
                pass

async def get_user(user_id: int, username: str = "", referrer_id: int = None):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT user_id, username, language, free_generations_used, stars_balance, total_generations, referrer_id, referred_count, bonus_generations FROM users WHERE user_id = ?",
            (user_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                return {
                    "user_id": row[0],
                    "username": row[1],
                    "language": row[2] or "uk",
                    "free_generations_used": row[3] or 0,
                    "stars_balance": row[4] or 0,
                    "total_generations": row[5] or 0,
                    "referrer_id": row[6],
                    "referred_count": row[7] or 0,
                    "bonus_generations": row[8] or 0,
                    "is_new": False,
                    "rewarded_referrer": None
                }
            else:
                now = time.time()
                valid_ref = None
                if referrer_id and isinstance(referrer_id, int) and referrer_id != user_id:
                    async with db.execute("SELECT user_id FROM users WHERE user_id = ?", (referrer_id,)) as r_cur:
                        if await r_cur.fetchone():
                            valid_ref = referrer_id

                await db.execute(
                    "INSERT INTO users (user_id, username, language, free_generations_used, stars_balance, total_generations, referrer_id, referred_count, bonus_generations, created_at) VALUES (?, ?, 'uk', 0, 0, 0, ?, 0, 0, ?)",
                    (user_id, username, valid_ref, now)
                )
                
                if valid_ref:
                    await db.execute(
                        "UPDATE users SET referred_count = referred_count + 1, bonus_generations = bonus_generations + 1 WHERE user_id = ?",
                        (valid_ref,)
                    )
                await db.commit()
                
                return {
                    "user_id": user_id,
                    "username": username,
                    "language": "uk",
                    "free_generations_used": 0,
                    "stars_balance": 0,
                    "total_generations": 0,
                    "referrer_id": valid_ref,
                    "referred_count": 0,
                    "bonus_generations": 0,
                    "is_new": True,
                    "rewarded_referrer": valid_ref
                }

async def update_free_use(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT free_generations_used, bonus_generations FROM users WHERE user_id = ?", (user_id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                free_used = row[0] or 0
                bonus_gens = row[1] or 0
                if free_used < FREE_GENERATIONS_LIMIT:
                    await db.execute("UPDATE users SET free_generations_used = free_generations_used + 1, total_generations = total_generations + 1 WHERE user_id = ?", (user_id,))
                elif bonus_gens > 0:
                    await db.execute("UPDATE users SET bonus_generations = MAX(0, bonus_generations - 1), total_generations = total_generations + 1 WHERE user_id = ?", (user_id,))
                else:
                    await db.execute("UPDATE users SET total_generations = total_generations + 1 WHERE user_id = ?", (user_id,))
                await db.commit()

async def deduct_stars(user_id: int, amount: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET stars_balance = MAX(0, stars_balance - ?), total_generations = total_generations + 1 WHERE user_id = ?", (amount, user_id))
        await db.commit()

async def add_stars(user_id: int, amount: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET stars_balance = stars_balance + ? WHERE user_id = ?", (amount, user_id))
        await db.commit()

async def set_user_language(user_id: int, lang: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET language = ? WHERE user_id = ?", (lang, user_id))
        await db.commit()

async def set_user_waiting_prompt(user_id: int, task_id: str, waiting: bool = True):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO user_sessions (user_id, current_task_id, waiting_for_prompt, updated_at) VALUES (?, ?, ?, ?)",
            (user_id, task_id, 1 if waiting else 0, time.time())
        )
        await db.commit()

async def get_user_session(user_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT current_task_id, waiting_for_prompt FROM user_sessions WHERE user_id = ?", (user_id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return {"current_task_id": row[0], "waiting_for_prompt": bool(row[1])}
            return {"current_task_id": None, "waiting_for_prompt": False}

# ==================== Presets Catalog ====================
CREATIVE_PRESETS = {
    # 📸 Headshot Studio
    "headshot_linkedin": {
        "cat": "headshot",
        "name_uk": "💼 LinkedIn Business Pro",
        "name_en": "💼 LinkedIn Business Pro",
        "prompt": "change clothes to a sharp tailored dark navy business suit with clean smooth solid wool fabric and crisp white shirt, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, preserve original lighting, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "headshot_editorial": {
        "cat": "headshot",
        "name_uk": "🌟 Глянцевий студійний портрет",
        "name_en": "🌟 Editorial Fashion Portrait",
        "prompt": "change clothes to an elegant luxury designer outfit, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, preserve original lighting, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    
    # 🌴 Travel Teleport
    "travel_bali": {
        "cat": "travel",
        "name_uk": "🏖️ Тропічний пляж на Балі",
        "name_en": "🏖️ Bali Tropical Beach",
        "prompt": "change background to a sunny tropical beach in Bali with palm trees and ocean waves at sunset, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "travel_paris": {
        "cat": "travel",
        "name_uk": "🗼 Тераса в Парижі",
        "name_en": "🗼 Paris Eiffel Balcony",
        "prompt": "change background to a classic Parisian balcony overlooking the Eiffel Tower with morning sunlight, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "travel_dubai": {
        "cat": "travel",
        "name_uk": "🌆 Дах хмарочоса в Дубаї",
        "name_en": "🌆 Dubai Luxury Rooftop",
        "prompt": "change background to a luxury rooftop in Dubai overlooking modern skyscrapers at golden sunset, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "travel_tokyo": {
        "cat": "travel",
        "name_uk": "🏮 Неоновий нічний Токіо",
        "name_en": "🏮 Tokyo Neon Cyber Night",
        "prompt": "change background to a night street in Tokyo Shibuya with glowing neon signs and cinematic reflections, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },

    # 👗 Fashion & Outfits
    "fashion_old_money": {
        "cat": "fashion",
        "name_uk": "🍸 Стиль Old Money Luxury",
        "name_en": "🍸 Old Money Luxury Style",
        "prompt": "change clothes to an elegant Old Money beige cashmere sweater and tailored linen trousers, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, preserve original lighting, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "fashion_evening_dress": {
        "cat": "fashion",
        "name_uk": "💃 Розкішна вечірня сукня",
        "name_en": "💃 Glamour Evening Gown",
        "prompt": "change clothes to a tailored luxury satin black evening gown, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, preserve original lighting, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "fashion_cyberpunk": {
        "cat": "fashion",
        "name_uk": "⚡ Cyberpunk Streetwear",
        "name_en": "⚡ Cyberpunk Techwear",
        "prompt": "change clothes to a futuristic cyberpunk techwear jacket with subtle glowing neon accents, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },

    # 💈 Hair & Beauty
    "beauty_blonde": {
        "cat": "beauty",
        "name_uk": "👱‍♀️ Платиновий блонд",
        "name_en": "👱‍♀️ Platinum Blonde Hair",
        "prompt": "change hair color to silky natural platinum blonde with soft waves, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "beauty_brunette_curls": {
        "cat": "beauty",
        "name_uk": "🍫 Шоколадні локони",
        "name_en": "🍫 Chocolate Brunette Curls",
        "prompt": "change hair to rich glossy chocolate brunette with soft voluminous curls, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },
    "beauty_golden_tan": {
        "cat": "beauty",
        "name_uk": "☀️ Бронзова літня засмага",
        "name_en": "☀️ Golden Summer Tan",
        "prompt": "change skin tone to a natural sun-kissed golden bronze tan with delicate warm highlights, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, clean smooth natural skin texture, seamless photorealistic integration, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    },

    # 🪄 Magic Clean
    "magic_clean": {
        "cat": "clean",
        "name_uk": "🪄 Очистити фон (Magic Clean)",
        "name_en": "🪄 Clean Background (Magic Clean)",
        "prompt": "remove all distracting background objects, wires, clutter, and extra people, make background clean and aesthetically blurred, keep exact same person, 100% exact original face, clothing, and identity completely unchanged, no text",
        "cfg": 1.95, "steps": 22, "seed": 888424
    }
}

SMOOTH_NEGATIVE = (
    "textured fabric, pattern, tweed, speckles, flecks, lint, dots on fabric, dotted texture, fabric dots, "
    "moles, excessive moles, freckles, skin spots, blemishes, noisy skin, "
    "speckled, dithering, salt and pepper noise, textured grain, pattern dots, "
    "text, words, letters, font, typography, watermark, signature, caption, logo, brand, poster, title, label, "
    "changed face, altered eyes, blurry face, different identity, fake skin, plastic wax, doll, airbrushed skin, "
    "deformed face, bad eyes, cartoon, deformed, blurry"
)

# ==================== Localization ====================
STRINGS = {
    "uk": {
        "welcome": (
            "✨ **Тут ви можете створити будь-яку фото-магію!**\n\n"
            "🎨 **Втілюйте власні ідеї без обмежень** — напишіть свій текстовий опис (*«додай вінтажну шкіряну куртку»*, *«зроби вечірній неоновий кіберпанк»* або *«перенеси на дах хмарочоса в Нью-Йорку»*).\n\n"
            "⚡ **Або скористайтеся нашими готовими студійними стилями:**\n"
            "• 📸 **Pro Headshot:** ділові студійні портрети для LinkedIn та резюме\n"
            "• 👗 **Fashion & Style:** віртуальна примірка суконь, костюмів та Old Money луків\n"
            "• 🌴 **Travel Teleport:** перенесення на Балі, в Париж, Дубай чи Токіо\n"
            "• 💈 **Hair & Beauty:** блонд, локони та літня засмага\n"
            "• 🪄 **Magic Clean:** очищення фону від зайвих людей та об'єктів\n\n"
            "👇 **Просто надішліть фото та творіть без меж!**"
        ),
        "menu_balance": "⭐️ Мій профіль / Баланс",
        "menu_help": "ℹ️ Інструкція",
        "choose_mode": (
            "✨ **Напишіть власний промпт (що змінити на фото)**\n"
            "або оберіть одну з готових студійних категорій нижче:\n\n"
            "👇 Натисніть кнопку, щоб втілити вашу ідею:"
        ),
        "btn_custom_prompt": "✏️ Написати власний промпт (Prompt)",
        "btn_headshot": "📸 Студійний портрет (Headshot)",
        "btn_travel": "🌴 Зміна локації (Travel)",
        "btn_fashion": "👗 Одяг та Стиль (Fashion)",
        "btn_beauty": "💈 Зачіска та Краса (Beauty)",
        "btn_clean": "🪄 Очистити фон (Magic Clean)",
        "btn_cancel": "❌ Скасувати генерацію",
        "btn_back": "🔙 Назад до вибору",
        "enter_prompt_prompt": (
            "✏️ **Напишіть будь-яку вашу ідею для фото:**\n\n"
            "_Наприклад: «додай сонцезахисні окуляри та білу сорочку» або «зроби фон на даху хмарочоса в Нью-Йорку»._\n\n"
            "👇 Надішліть вашу інструкцію повідомленням у чат:"
        ),
        "queue_added": "⏳ **Фото додано в чергу обробки!**\n🎨 Режим: **{preset_name}**\n📊 Статус: {quota_str}\n⏱️ Орієнтовний час: **~{eta}s**",
        "rendering": "☁️ **Генеруємо зміни...**\n⚙️ Обробка на Nvidia L40S 48GB GPU...\n⏱️ Орієнтовний час: ~{eta}s",
        "done": "✅ **Готово! Результат успішно згенеровано:**",
        "limit_reached": "⛔ **Вичерпано безкоштовні генерації!**\nДля продовження поповніть баланс через Telegram Stars (10 ⭐ за генерацію)."
    },
    "en": {
        "welcome": (
            "✨ **Create any photo magic with limitless AI creativity!**\n\n"
            "🎨 **Bring your unique ideas to life** — write your own custom prompt (*'add a vintage leather jacket'*, *'place in cyberpunk neon night'*, or *'teleport to a Manhattan rooftop at sunset'*).\n\n"
            "⚡ **Or choose from our ready-made curated styles:**\n"
            "• 📸 **Pro Headshot:** studio portraits for LinkedIn, Tinder & resumes\n"
            "• 👗 **Fashion & Style:** virtual try-on, Old Money & luxury outfits\n"
            "• 🌴 **Travel Teleport:** teleport to Bali, Paris, Dubai, or Tokyo\n"
            "• 💈 **Hair & Beauty:** blonde hair, brunette curls & golden tan\n"
            "• 🪄 **Magic Clean:** erase background clutter and extra people\n\n"
            "👇 **Simply send a photo to start creating!**"
        ),
        "menu_balance": "⭐️ Profile / Balance",
        "menu_help": "ℹ️ Guide",
        "choose_mode": (
            "✨ **Write your custom prompt (describe what to change)**\n"
            "or choose a ready-made studio style below:\n\n"
            "👇 Tap a button to bring your idea to life:"
        ),
        "btn_custom_prompt": "✏️ Write Custom Prompt",
        "btn_headshot": "📸 Studio Headshot",
        "btn_travel": "🌴 Travel Teleport",
        "btn_fashion": "👗 Fashion & Style",
        "btn_beauty": "💈 Hair & Beauty",
        "btn_clean": "🪄 Magic Clean",
        "btn_cancel": "❌ Cancel Generation",
        "btn_back": "🔙 Back",
        "enter_prompt_prompt": (
            "✏️ **Describe what to change on the photo:**\n\n"
            "_Example: 'add sunglasses and a white linen shirt' or 'make background a rooftop in New York at sunset'._\n\n"
            "👇 Send your instruction as a text message:"
        ),
        "queue_added": "⏳ **Photo queued for AI processing!**\n🎨 Mode: **{preset_name}**\n📊 Quota: {quota_str}\n⏱️ Estimated time: **~{eta}s**",
        "rendering": "☁️ **Rendering edits...**\n⚙️ Processing on Nvidia L40S 48GB GPU...\n⏱️ Estimated time: ~{eta}s",
        "done": "✅ **Done! Here is your AI generated result:**",
        "limit_reached": "⛔ **Free generation limit reached!**\nTop up your Telegram Stars balance to continue (10 ⭐ per generation)."
    }
}

# ==================== Keyboard Builders ====================
def get_main_keyboard(lang="uk"):
    return ReplyKeyboardRemove()

def get_photo_menu_keyboard(task_id: str, lang="uk"):
    t = STRINGS[lang]
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(t["btn_custom_prompt"], callback_data=f"ask_prompt:{task_id}")],
        [
            InlineKeyboardButton(t["btn_headshot"], callback_data=f"cat:headshot:{task_id}"),
            InlineKeyboardButton(t["btn_travel"], callback_data=f"cat:travel:{task_id}")
        ],
        [
            InlineKeyboardButton(t["btn_fashion"], callback_data=f"cat:fashion:{task_id}"),
            InlineKeyboardButton(t["btn_beauty"], callback_data=f"cat:beauty:{task_id}")
        ],
        [InlineKeyboardButton(t["btn_clean"], callback_data=f"exec_preset:magic_clean:{task_id}")],
        [InlineKeyboardButton(t["btn_cancel"], callback_data=f"cancel_task:{task_id}")]
    ])

def get_category_keyboard(category: str, task_id: str, lang="uk"):
    buttons = []
    for pid, pcfg in CREATIVE_PRESETS.items():
        if pcfg["cat"] == category:
            pname = pcfg[f"name_{lang}"]
            buttons.append([InlineKeyboardButton(pname, callback_data=f"exec_preset:{pid}:{task_id}")])
    buttons.append([InlineKeyboardButton(STRINGS[lang]["btn_back"], callback_data=f"back_to_menu:{task_id}")])
    return InlineKeyboardMarkup(buttons)

QUICK_IDEAS = {
    "idea_sunglasses": {
        "title_uk": "🕶 Додати темні окуляри",
        "title_en": "🕶 Add Stylish Sunglasses",
        "prompt": "Add stylish designer black sunglasses to the person's face. Keep the person's face, facial features, hair, skin, and identity completely unchanged."
    },
    "idea_leather_jacket": {
        "title_uk": "🧥 Шкіряна байкерська куртка",
        "title_en": "🧥 Black Leather Jacket",
        "prompt": "Replace the clothing with a stylish black motorcycle leather jacket. Keep the person's face, facial features, hair, and identity completely unchanged."
    },
    "idea_sunset_beach": {
        "title_uk": "🌅 Захід сонця на морі",
        "title_en": "🌅 Golden Sunset Beach",
        "prompt": "Change the background to a calm sandy beach during golden hour sunset with warm sunlight. Keep the person's face, facial features, and identity completely unchanged."
    },
    "idea_cozy_cafe": {
        "title_uk": "☕ Затишне паризьке кафе",
        "title_en": "☕ Cozy European Cafe",
        "prompt": "Change the background to an outdoor table of a charming European Parisian cafe with warm ambient lights. Keep the person's face, facial features, and identity completely unchanged."
    },
    "idea_sports_car": {
        "title_uk": "🏎 Поруч червоний спорткар",
        "title_en": "🏎 Red Luxury Supercar",
        "prompt": "Place a glossy red luxury supercar next to the person in the background with modern architecture. Keep the person's face, facial features, and identity completely unchanged."
    },
    "idea_sakura": {
        "title_uk": "🌸 Квітучий сад сакури",
        "title_en": "🌸 Blooming Sakura Garden",
        "prompt": "Change the background to a blooming Japanese pink cherry blossom sakura garden with soft pastel daylight. Keep the person's face, facial features, and identity completely unchanged."
    }
}

def enhance_custom_prompt(raw_prompt: str) -> str:
    p = raw_prompt.strip()
    if not p.lower().startswith("change") and not p.lower().startswith("replace") and not p.lower().startswith("add") and not p.lower().startswith("remove") and not p.lower().startswith("keep"):
        return f"{p}, keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, seamless photorealistic integration, no text"
    if "100% exact original face" not in p.lower():
        p += ", keep exact same person, 100% exact original face, sharp focused eyes and gaze, exact original lips and expression, exact original skin color and tone, seamless photorealistic integration, no text"
    return p

def get_prompt_ideas_keyboard(task_id: str, lang="uk"):
    buttons = []
    # Add quick prompt ideas
    for i_id, i_data in QUICK_IDEAS.items():
        title = i_data[f"title_{lang}"]
        buttons.append([InlineKeyboardButton(title, callback_data=f"exec_idea:{i_id}:{task_id}")])
    
    buttons.append([InlineKeyboardButton(STRINGS[lang]["btn_back"], callback_data=f"back_to_menu:{task_id}")])
    buttons.append([InlineKeyboardButton(STRINGS[lang]["btn_cancel"], callback_data=f"cancel_task:{task_id}")])
    return InlineKeyboardMarkup(buttons)

def get_cancel_keyboard(task_id: str, lang="uk"):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(STRINGS[lang]["btn_cancel"], callback_data=f"cancel_task:{task_id}")]
    ])

def get_result_keyboard(task_id: str, lang="uk", user_id: int = 0, bot_username: str = ""):
    ref_link = f"https://t.me/{bot_username}?start=ref_{user_id}" if bot_username and user_id else "https://t.me/"
    share_text = (
        "🔥 Спробуй AI Photo Studio! Студійні портрети, зміна одягу та стилізація в 1 клік. Отримай безкоштовні генерації за цим посиланням:"
        if lang == "uk" else
        "🔥 Check out AI Photo Studio! Studio headshots, outfits and styles in 1 click. Get free generations via this link:"
    )
    share_url = f"https://t.me/share/url?url={urllib.parse.quote(ref_link)}&text={urllib.parse.quote(share_text)}"
    
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🎨 Спробувати інший стиль" if lang == "uk" else "🎨 Try Another Style", callback_data=f"back_to_menu:{task_id}")],
        [InlineKeyboardButton("🎁 Отримати +1 спробу (Запросити друга)" if lang == "uk" else "🎁 Get +1 Free (Invite Friend)", url=share_url)],
        [InlineKeyboardButton("⭐️ Поповнити Stars" if lang == "uk" else "⭐️ Top Up Stars", callback_data="buy_stars_menu")]
    ])

# ==================== Core Cloud Generation ====================
def prepare_image_for_cloud(input_img_path, max_dim=1024):
    img = Image.open(input_img_path).convert("RGB")
    w, h = img.size
    scale = min(1.0, max_dim / max(w, h))
    new_w = max(64, int(w * scale) // 16 * 16)
    new_h = max(64, int(h * scale) // 16 * 16)
    if (new_w, new_h) != (w, h):
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

def generate_qwen_cloud_sync(input_img_path, task_id, prompt, cfg=1.95, steps=22, seed=888424):
    global LAST_GENERATION_DURATION
    print(f"[*] [Cloud API] Sending task {task_id}, prompt: {prompt[:60]}...", flush=True)
    img_b64 = prepare_image_for_cloud(input_img_path, max_dim=1024)
    
    payload = {
        "image_base64": img_b64,
        "prompt": prompt,
        "negative_prompt": SMOOTH_NEGATIVE,
        "steps": steps,
        "cfg": cfg,
        "seed": seed
    }
    headers = {"Content-Type": "application/json"}
    t0 = time.time()
    
    resp = requests.post(MODAL_ENDPOINT_URL, json=payload, headers=headers, timeout=600)
    dur = round(time.time() - t0, 1)
    LAST_GENERATION_DURATION = dur
    
    if resp.status_code == 200:
        data = resp.json()
        if data.get("status") == "success":
            out_b64 = data.get("result_base64")
            out_path = os.path.join(OUTPUT_STORAGE, f"{task_id}_result.png")
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(out_b64))
            print(f"[+] [Cloud API] Successfully saved result: {out_path} ({dur}s)", flush=True)
            return {"path": out_path, "duration": dur}
        else:
            raise RuntimeError(f"Modal API Error: {data.get('error')}")
    else:
        raise RuntimeError(f"Modal HTTP {resp.status_code}: {resp.text[:300]}")

# ==================== Worker & Queue ====================
CREATIVE_QUEUE = asyncio.Queue()

async def creative_queue_worker(bot):
    print("[+] Creative AI Cloud Queue Worker started listening...", flush=True)
    loop = asyncio.get_running_loop()
    while True:
        task = await CREATIVE_QUEUE.get()
        try:
            task_id, user_id, username, input_path, prompt, display_title, status_msg, is_free, lang, target_bot, cfg = task
            active_bot = target_bot or bot
            
            # Check for cancellation
            async with aiosqlite.connect(DB_PATH) as db:
                async with db.execute("SELECT status FROM task_journal WHERE task_id = ?", (task_id,)) as cursor:
                    row = await cursor.fetchone()
                    if row and row[0] == "CANCELLED":
                        print(f"[*] Task {task_id} was CANCELLED. Skipping.", flush=True)
                        continue
                await db.execute("UPDATE task_journal SET status = 'IN_PROGRESS' WHERE task_id = ?", (task_id,))
                await db.commit()

            if status_msg:
                try:
                    await status_msg.edit_text(
                        STRINGS[lang]["rendering"].format(eta=int(LAST_GENERATION_DURATION)),
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass

            t0 = time.time()
            res = await loop.run_in_executor(None, generate_qwen_cloud_sync, input_path, task_id, prompt, cfg)
            gen_dur = round(time.time() - t0, 1)

            # Deduct quota or charge stars
            if is_free:
                await update_free_use(user_id)
            else:
                await deduct_stars(user_id, PRICE_STARS)

            user_info = await get_user(user_id, username)
            is_adm = is_super_admin(user_id, username)
            free_used = user_info.get("free_generations_used", 0)
            bonus_gens = user_info.get("bonus_generations", 0)
            std_free_left = max(0, FREE_GENERATIONS_LIMIT - free_used)
            total_free_left = std_free_left + bonus_gens

            if is_adm:
                free_str = "∞ (Admin)"
            elif bonus_gens > 0:
                free_str = f"{total_free_left} ({std_free_left} баз. + {bonus_gens} бон.)"
            else:
                free_str = f"{total_free_left} з {FREE_GENERATIONS_LIMIT}"

            caption = (
                f"✨ **{display_title}**\n\n"
                f"⚡ Час генерації: `{gen_dur}s`\n"
                f"🎁 Залишилось безкоштовних: `{free_str}`\n"
                f"⭐️ Баланс Stars: `{user_info['stars_balance']} XTR`"
                if lang == "uk" else
                f"✨ **{display_title}**\n\n"
                f"⚡ Generation Time: `{gen_dur}s`\n"
                f"🎁 Free quota left: `{free_str}`\n"
                f"⭐️ Stars Balance: `{user_info['stars_balance']} XTR`"
            )

            bot_uname = active_bot.username or "AuraCreativeStudioBot"
            with open(res["path"], "rb") as pf:
                await active_bot.send_photo(
                    chat_id=user_id,
                    photo=pf,
                    caption=caption,
                    reply_markup=get_result_keyboard(task_id, lang, user_id=user_id, bot_username=bot_uname),
                    parse_mode="Markdown"
                )

            async with aiosqlite.connect(DB_PATH) as db:
                await db.execute("UPDATE task_journal SET status = 'COMPLETED' WHERE task_id = ?", (task_id,))
                await db.commit()

            if status_msg:
                try:
                    await status_msg.delete()
                except Exception:
                    pass

        except Exception as e:
            print(f"[!] Error in creative_queue_worker: {e}", flush=True)
            import traceback
            traceback.print_exc()
            if status_msg:
                try:
                    err_msg = f"❌ **Помилка обробки:** {e}" if lang == "uk" else f"❌ **Processing error:** {e}"
                    await status_msg.edit_text(err_msg, parse_mode="Markdown")
                except Exception:
                    pass
        finally:
            CREATIVE_QUEUE.task_done()

# ==================== Bot Command & Event Handlers ====================
async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    
    # Parse referral payload if present: /start ref_123456
    referrer_id = None
    if context.args and len(context.args) > 0:
        arg = context.args[0]
        if arg.startswith("ref_"):
            try:
                referrer_id = int(arg.replace("ref_", ""))
            except ValueError:
                referrer_id = None

    user = await get_user(user_id, username, referrer_id=referrer_id)
    lang = user.get("language", "uk")
    
    # If a referrer was successfully rewarded, notify them!
    if user.get("rewarded_referrer"):
        ref_id = user["rewarded_referrer"]
        try:
            invited_name = f"@{username}" if username else f"ID: {user_id}"
            await context.bot.send_message(
                chat_id=ref_id,
                text=(
                    f"🎉 **Ваш друг {invited_name} приєднався за вашим запрошенням!**\n\n"
                    f"🎁 Вам нараховано **+1 безкоштовну генерацію**!\n"
                    f"Надішліть будь-яке фото, щоб скористатися бонусом."
                ),
                parse_mode="Markdown"
            )
        except Exception as e:
            print(f"[!] Could not send referral notification to {ref_id}: {e}", flush=True)

    await update.message.reply_text(
        STRINGS[lang]["welcome"],
        reply_markup=get_main_keyboard(lang),
        parse_mode="Markdown"
    )

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")
    await update.message.reply_text(
        STRINGS[lang]["welcome"],
        reply_markup=get_main_keyboard(lang),
        parse_mode="Markdown"
    )

async def invite_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")
    bot_info = await context.bot.get_me()
    bot_uname = bot_info.username or "AuraCreativeStudioBot"
    ref_link = f"https://t.me/{bot_uname}?start=ref_{user_id}"
    
    referred_count = user.get("referred_count", 0)
    bonus_gens = user.get("bonus_generations", 0)
    
    share_text = (
        "🔥 Спробуй AI Photo Studio! Студійні портрети, зміна одягу та стилізація в 1 клік. Отримай безкоштовні генерації за цим посиланням:"
        if lang == "uk" else
        "🔥 Check out AI Photo Studio! Studio headshots, outfits and styles in 1 click. Get free generations via this link:"
    )
    share_url = f"https://t.me/share/url?url={urllib.parse.quote(ref_link)}&text={urllib.parse.quote(share_text)}"
    
    text = (
        f"🎁 **Реферальна програма — Отримуйте безкоштовні фото!**\n\n"
        f"Запрошуйте друзів та отримуйте **+1 безкоштовну генерацію** за кожного нового користувача, який скористається ботом!\n\n"
        f"📊 **Ваша статистика:**\n"
        f"• Запрошено друзів: `{referred_count}`\n"
        f"• Доступно бонусних спроб: `{bonus_gens}`\n\n"
        f"🔗 **Ваше персональне посилання:**\n"
        f"`{ref_link}`\n"
        f"_(Натисніть на посилання, щоб скопіювати)_\n\n"
        f"👇 Натисніть кнопку нижче, щоб надіслати друзям в 1 клік:"
        if lang == "uk" else
        f"🎁 **Referral Program — Get Free Photos!**\n\n"
        f"Invite friends and get **+1 free generation** for every new user who joins!\n\n"
        f"📊 **Your Stats:**\n"
        f"• Friends invited: `{referred_count}`\n"
        f"• Active bonus generations: `{bonus_gens}`\n\n"
        f"🔗 **Your Referral Link:**\n"
        f"`{ref_link}`\n\n"
        f"👇 Tap below to share with friends in 1 click:"
    )
    
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("📲 Надіслати друзям у Telegram" if lang == "uk" else "📲 Share in Telegram", url=share_url)],
        [InlineKeyboardButton("⭐️ Поповнити Stars" if lang == "uk" else "⭐️ Top Up Stars", callback_data="buy_stars_menu")]
    ])
    
    if update.callback_query:
        await update.callback_query.message.reply_text(text, reply_markup=kb, parse_mode="Markdown")
    else:
        await update.message.reply_text(text, reply_markup=kb, parse_mode="Markdown")

async def balance_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")
    admin = is_super_admin(user_id, username)
    
    free_used = user.get("free_generations_used", 0)
    bonus_gens = user.get("bonus_generations", 0)
    referred_count = user.get("referred_count", 0)
    std_free_left = max(0, FREE_GENERATIONS_LIMIT - free_used)
    total_free_left = std_free_left + bonus_gens
    
    if admin:
        free_str = "👑 Unlimited (Super Admin)"
    elif bonus_gens > 0:
        free_str = f"{total_free_left} ({std_free_left} баз. + {bonus_gens} бон.)"
    else:
        free_str = f"{total_free_left} з {FREE_GENERATIONS_LIMIT}"
    
    bot_info = await context.bot.get_me()
    bot_uname = bot_info.username or "AuraCreativeStudioBot"
    ref_link = f"https://t.me/{bot_uname}?start=ref_{user_id}"
    share_text = (
        "🔥 Спробуй AI Photo Studio! Студійні портрети, зміна одягу та стилізація в 1 клік. Отримай безкоштовні генерації за цим посиланням:"
        if lang == "uk" else
        "🔥 Check out AI Photo Studio! Studio headshots, outfits and styles in 1 click. Get free generations via this link:"
    )
    share_url = f"https://t.me/share/url?url={urllib.parse.quote(ref_link)}&text={urllib.parse.quote(share_text)}"

    text = (
        f"⭐️ **Ваш профіль та баланс:**\n\n"
        f"👤 Користувач: `@{username}` (ID: `{user_id}`)\n"
        f"🎁 Доступно безкоштовних спроб: `{free_str}`\n"
        f"👥 Запрошено друзів: `{referred_count}`\n"
        f"⭐ Баланс Stars: `{user['stars_balance']}` XTR\n"
        f"🎨 Всього генерацій: `{user['total_generations']}`\n\n"
        f"🔗 **Ваше реферальне посилання:**\n`{ref_link}`"
        if lang == "uk" else
        f"⭐️ **Your Profile & Balance:**\n\n"
        f"👤 User: `@{username}` (ID: `{user_id}`)\n"
        f"🎁 Free quota left: `{free_str}`\n"
        f"👥 Friends invited: `{referred_count}`\n"
        f"⭐ Stars Balance: `{user['stars_balance']}` XTR\n"
        f"🎨 Total generations: `{user['total_generations']}`\n\n"
        f"🔗 **Referral Link:**\n`{ref_link}`"
    )
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("🎁 Запросити друзів (+1 спроба)" if lang == "uk" else "🎁 Invite Friends (+1 Free)", url=share_url)],
        [InlineKeyboardButton("⭐️ 10 Stars (1 фото)", callback_data="buy_stars:10")],
        [InlineKeyboardButton("⭐️ 50 Stars (5 фото)", callback_data="buy_stars:50")],
        [InlineKeyboardButton("⭐️ 100 Stars (10 фото + Бонус)", callback_data="buy_stars:100")]
    ])
    if update.callback_query:
        await update.callback_query.message.reply_text(text, reply_markup=kb, parse_mode="Markdown")
    else:
        await update.message.reply_text(text, reply_markup=kb, parse_mode="Markdown")

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")
    now = time.time()

    photo_file = await update.message.photo[-1].get_file()
    task_id = f"creative_{user_id}_{int(now)}"
    input_filepath = os.path.join(INPUT_STORAGE, f"{task_id}.jpg")
    await photo_file.download_to_drive(input_filepath)

    caption = update.message.caption or ""
    if caption.strip():
        # Immediate Custom Prompt mode if caption is provided
        await enqueue_creative_task(update, context, user_id, username, user, task_id, input_filepath, caption.strip(), f"Custom: {caption.strip()[:30]}", lang)
    else:
        # Prompt mode selection menu
        await set_user_waiting_prompt(user_id, task_id, waiting=False)
        await update.message.reply_text(
            STRINGS[lang]["choose_mode"],
            reply_markup=get_photo_menu_keyboard(task_id, lang),
            parse_mode="Markdown"
        )

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")
    text = update.message.text.strip()

    session = await get_user_session(user_id)
    if session.get("current_task_id"):
        task_id = session["current_task_id"]
        input_filepath = os.path.join(INPUT_STORAGE, f"{task_id}.jpg")
        if os.path.exists(input_filepath):
            await set_user_waiting_prompt(user_id, None, waiting=False)
            await enqueue_creative_task(update, context, user_id, username, user, task_id, input_filepath, text, f"Custom: {text[:30]}", lang)
            return

    if text in [STRINGS["uk"]["menu_balance"], STRINGS["en"]["menu_balance"]]:
        await balance_cmd(update, context)
    elif text in [STRINGS["uk"]["menu_help"], STRINGS["en"]["menu_help"]]:
        await help_cmd(update, context)
    elif text.startswith("/invite") or text.startswith("/ref"):
        await invite_cmd(update, context)
    else:
        await update.message.reply_text(
            "📸 Будь ласка, спочатку надішліть фото, яке ви бажаєте відредагувати!" if lang == "uk" else "📸 Please send a photo you want to edit first!"
        )

async def enqueue_creative_task(update, context, user_id, username, user, task_id, input_filepath, prompt, title, lang, cfg=1.55):
    admin = is_super_admin(user_id, username)
    free_used = user.get("free_generations_used", 0)
    bonus_gens = user.get("bonus_generations", 0)
    std_free_left = max(0, FREE_GENERATIONS_LIMIT - free_used)
    total_free_left = std_free_left + bonus_gens
    is_free = admin or (total_free_left > 0)

    if not is_free and user["stars_balance"] < PRICE_STARS:
        await update.message.reply_text(STRINGS[lang]["limit_reached"], parse_mode="Markdown")
        prices = [LabeledPrice("1 AI Generation", PRICE_STARS)]
        await context.bot.send_invoice(
            chat_id=user_id,
            title="⭐️ Оплата 10 Stars",
            description="Оплата 1 креативної AI генерації",
            payload=f"stars_{user_id}_{int(time.time())}_{PRICE_STARS}",
            currency="XTR",
            prices=prices,
            provider_token=""
        )
        return

    quota_str = "👑 Super Admin" if admin else (f"🟢 Залишилось {total_free_left} безкоштовних" if is_free else f"⭐ Оплата {PRICE_STARS} Stars")
    status_text = STRINGS[lang]["queue_added"].format(
        preset_name=title,
        quota_str=quota_str,
        eta=int(LAST_GENERATION_DURATION)
    )
    status_msg = await update.message.reply_text(
        status_text,
        reply_markup=get_cancel_keyboard(task_id, lang),
        parse_mode="Markdown"
    )

    final_prompt = enhance_custom_prompt(prompt)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO task_journal (task_id, user_id, input_path, prompt, category, status, is_free, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)",
            (task_id, user_id, input_filepath, final_prompt, title, 1 if is_free else 0, time.time())
        )
        await db.commit()

    await CREATIVE_QUEUE.put((task_id, user_id, username, input_filepath, final_prompt, title, status_msg, is_free, lang, context.bot, cfg))

async def callback_dispatcher(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = update.effective_user.id
    username = update.effective_user.username or ""
    user = await get_user(user_id, username)
    lang = user.get("language", "uk")

    # Cancel task
    if data.startswith("cancel_task:"):
        tid = data.split(":", 1)[1]
        async with aiosqlite.connect(DB_PATH) as db:
            async with db.execute("SELECT status FROM task_journal WHERE task_id = ?", (tid,)) as cursor:
                row = await cursor.fetchone()
                if row and row[0] == "PENDING":
                    await db.execute("UPDATE task_journal SET status = 'CANCELLED' WHERE task_id = ?", (tid,))
                    await db.commit()
                    await query.edit_message_text("🚫 **Генерацію успішно скасовано.**\nВаші безкоштовні спроби та зірки збережено!", parse_mode="Markdown")
                elif row and row[0] == "IN_PROGRESS":
                    await query.answer("⚠️ Генерація вже обробляється нейромережею і не може бути скасована.", show_alert=True)
                else:
                    await query.answer("ℹ️ Таска вже завершена або скасована.")
        return

    # Back to main photo menu
    if data.startswith("back_to_menu:"):
        tid = data.split(":", 1)[1]
        await query.edit_message_text(
            STRINGS[lang]["choose_mode"],
            reply_markup=get_photo_menu_keyboard(tid, lang),
            parse_mode="Markdown"
        )
        return

    # Category Selection
    if data.startswith("cat:"):
        _, cat, tid = data.split(":", 2)
        await query.edit_message_text(
            f"🎨 **Оберіть потрібний стиль:**" if lang == "uk" else "🎨 **Select desired style:**",
            reply_markup=get_category_keyboard(cat, tid, lang),
            parse_mode="Markdown"
        )
        return

    # Prompt Request Prompt & Quick Ideas
    if data.startswith("ask_prompt:"):
        tid = data.split(":", 1)[1]
        await set_user_waiting_prompt(user_id, tid, waiting=True)
        await query.edit_message_text(
            STRINGS[lang]["enter_prompt_prompt"],
            reply_markup=get_prompt_ideas_keyboard(tid, lang),
            parse_mode="Markdown"
        )
        return

    # Execute Quick Idea
    if data.startswith("exec_idea:"):
        _, i_id, tid = data.split(":", 2)
        await set_user_waiting_prompt(user_id, tid, waiting=False)
        idata = QUICK_IDEAS.get(i_id, QUICK_IDEAS["idea_sunglasses"])
        prompt = idata["prompt"]
        title = idata[f"title_{lang}"]
        input_filepath = os.path.join(INPUT_STORAGE, f"{tid}.jpg")
        await enqueue_creative_task(query, context, user_id, username, user, tid, input_filepath, prompt, title, lang)
        return

    # Execute Preset
    if data.startswith("exec_preset:"):
        _, pid, tid = data.split(":", 2)
        pcfg = CREATIVE_PRESETS.get(pid, CREATIVE_PRESETS.get("magic_clean"))
        prompt = pcfg["prompt"]
        title = pcfg[f"name_{lang}"]
        cfg_val = pcfg.get("cfg", 1.95)
        input_filepath = os.path.join(INPUT_STORAGE, f"{tid}.jpg")
        await enqueue_creative_task(query, context, user_id, username, user, tid, input_filepath, prompt, title, lang, cfg=cfg_val)
        return

    # Buy stars menu
    if data == "buy_stars_menu":
        await balance_cmd(update, context)
        return

    # Invite menu
    if data == "invite_menu":
        await invite_cmd(update, context)
        return

    # Buy stars package
    if data.startswith("buy_stars:"):
        amount = int(data.split(":")[1])
        prices = [LabeledPrice(f"{amount} Stars", amount)]
        await context.bot.send_invoice(
            chat_id=user_id,
            title=f"⭐️ Поповнення {amount} Stars",
            description=f"Пакет на {amount // 10} генерацій",
            payload=f"topup_stars_{user_id}_{int(time.time())}_{amount}",
            currency="XTR",
            prices=prices,
            provider_token=""
        )
        return

async def pre_checkout_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.pre_checkout_query
    await query.answer(ok=True)

async def successful_payment_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    payment = update.message.successful_payment
    amount = payment.total_amount
    await add_stars(user_id, amount)
    await update.message.reply_text(
        f"🎉 **Оплату успішно зараховано!** (+{amount} ⭐ Stars)\nНадішліть фото для редагування!",
        reply_markup=get_main_keyboard("uk"),
        parse_mode="Markdown"
    )

# ==================== Application Lifecycle ====================
def main():
    print("=" * 65, flush=True)
    print("=== Launching Telegram Creative AI Studio Bot ===", flush=True)
    print("=" * 65, flush=True)

    if not BOT_TOKEN:
        print("[!] No CREATIVE_BOT_TOKEN or BOT_TOKEN specified! Exiting.", flush=True)
        sys.exit(1)

    if not acquire_single_instance_lock():
        sys.exit(0)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    loop.run_until_complete(init_db())

    async def bot_post_init(application):
        try:
            await application.bot.set_my_commands([
                BotCommand("start", "🏠 Головне меню / Main Menu"),
                BotCommand("invite", "🎁 Запросити друзів (+1 спроба) / Referrals"),
                BotCommand("balance", "⭐️ Профіль та Баланс / Profile"),
                BotCommand("help", "ℹ️ Інструкція / Guide")
            ])
            await application.bot.set_chat_menu_button(menu_button=MenuButtonCommands())
        except Exception as e:
            print(f"[!] set_my_commands error: {e}", flush=True)

        asyncio.create_task(creative_queue_worker(application.bot))

    app = ApplicationBuilder().token(BOT_TOKEN).post_init(bot_post_init).build()

    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("invite", invite_cmd))
    app.add_handler(CommandHandler("ref", invite_cmd))
    app.add_handler(CommandHandler("referral", invite_cmd))
    app.add_handler(CommandHandler("profile", balance_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("balance", balance_cmd))
    app.add_handler(CommandHandler("stars", balance_cmd))

    app.add_handler(CallbackQueryHandler(callback_dispatcher))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(PreCheckoutQueryHandler(pre_checkout_callback))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment_callback))

    print("[+] Creative AI Bot is Polling and Ready!", flush=True)
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
