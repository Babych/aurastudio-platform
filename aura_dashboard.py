import http.server
import socketserver
import json
import subprocess
import os
import sys
import time
import urllib.parse
import threading
from datetime import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# ----------------- Environment Configuration Loader -----------------
def load_env_file(filepath=None):
    paths_to_check = [
        filepath,
        os.path.join(os.getcwd(), ".env"),
        os.path.join(os.path.dirname(__file__), ".env") if "__file__" in globals() else None,
        r"C:\Users\ITX\.env"
    ]
    for p in paths_to_check:
        if p and os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            os.environ.setdefault(k.strip(), v.strip().strip("'\""))
                break
            except Exception:
                pass

load_env_file()

PORT = int(os.getenv("AURA_DASHBOARD_PORT", "8091"))
SUPER_ADMIN_IDS = [
    int(i.strip())
    for i in os.getenv("SUPER_ADMIN_IDS", "").split(",")
    if i.strip().isdigit()
]

# Cache dictionary for live metrics
LATEST_DATA = {
    "timestamp": time.time(),
    "bot_status": {"online": False, "pid": None, "memory_mb": 0, "node_ip": "192.168.1.152 (ITX Node)"},
    "modal_status": {
        "app_id": "ap-oazJqxY0tayw2OCFhr9NRS",
        "app_name": "qwen-image-edit-fp8-service",
        "gpu": "Nvidia L40S (48GB VRAM)",
        "model": "Qwen 2.5 DiT 20B (Q6_K 6-Bit Master, 15.2 GB)",
        "active_containers": 0,
        "state": "IDLE (Scale-to-Zero)",
        "container_ids": []
    },
    "stats": {
        "total_users": 0,
        "total_generations": 0,
        "total_stars_balance": 0,
        "queue_size": 0,
        "last_duration": 56.8
    },
    "recent_tasks": [],
    "recent_users": [],
    "log_tail": ""
}

def poll_aura_state():
    global LATEST_DATA
    creative_db = r"D:\AI_Workspace\ComfyUI\creative_bot_temp\creative_bot.db"
    
    while True:
        try:
            # 1. Query Telegram Bot Process
            bot_online = False
            bot_pid = None
            bot_mem = 0
            
            try:
                ps_cmd = 'tasklist | findstr python'
                res = subprocess.run(ps_cmd, shell=True, capture_output=True, text=True, timeout=5)
                if res.returncode == 0 and res.stdout.strip():
                    lines = [l.strip() for l in res.stdout.splitlines() if "python" in l.lower()]
                    if lines:
                        bot_online = True
                        for l in lines:
                            parts = l.split()
                            if len(parts) >= 5:
                                pid_cand = parts[1]
                                mem_str = parts[-2].replace(",", "").replace(".", "")
                                try:
                                    mem_kb = int(mem_str)
                                    if mem_kb > 10000:
                                        bot_pid = pid_cand
                                        bot_mem = round(mem_kb / 1024, 1)
                                        break
                                except Exception:
                                    pass
                        if not bot_pid and lines:
                            bot_pid = lines[0].split()[1] if len(lines[0].split()) > 1 else "Active"
            except Exception:
                pass

            # 2. Query Aura Creative Database
            tasks_list = []
            users_list = []
            total_users = 0
            total_gens = 0
            total_stars = 0
            queue_size = 0

            if os.path.exists(creative_db):
                try:
                    import sqlite3
                    conn = sqlite3.connect(creative_db)
                    c = conn.cursor()
                    
                    # Fetch Users
                    c.execute("SELECT user_id, username, free_generations_used, stars_balance FROM users ORDER BY user_id DESC")
                    for u_tuple in c.fetchall():
                        uid = u_tuple[0]
                        users_list.append({
                            "user_id": uid,
                            "username": u_tuple[1] or f"user_{uid}",
                            "free_used": u_tuple[2] or 0,
                            "free_left": max(0, 3 - (u_tuple[2] or 0)),
                            "stars_balance": u_tuple[3] or 0,
                            "is_admin": uid in SUPER_ADMIN_IDS
                        })
                        total_users += 1
                        total_stars += (u_tuple[3] or 0)
                        
                    # Fetch Tasks Journal
                    c.execute("SELECT task_id, user_id, prompt, category, status, created_at FROM task_journal ORDER BY created_at DESC LIMIT 60")
                    for t_tuple in c.fetchall():
                        try:
                            ts = float(t_tuple[5]) if len(t_tuple) > 5 and t_tuple[5] else 0.0
                        except Exception:
                            ts = 0.0
                        created_dt = datetime.fromtimestamp(ts).strftime("%d.%m %H:%M:%S") if ts else "--:--"
                        tid = t_tuple[0]
                        u_name = next((u["username"] for u in users_list if u["user_id"] == t_tuple[1]), f"user_{t_tuple[1]}")
                        tasks_list.append({
                            "task_id": tid,
                            "raw_task_id": tid,
                            "user_id": t_tuple[1],
                            "username": u_name,
                            "preset_id": t_tuple[3] or "Custom Style",
                            "prompt": t_tuple[2] or "N/A",
                            "status": t_tuple[4],
                            "time": created_dt,
                            "timestamp": ts,
                            "has_images": True,
                            "input_url": f"/api/image?type=creative_input&task_id={tid}",
                            "output_url": f"/api/image?type=creative_output&task_id={tid}"
                        })
                        if t_tuple[4] == "COMPLETED":
                            total_gens += 1
                        elif t_tuple[4] in ("PENDING", "IN_PROGRESS"):
                            queue_size += 1
                    conn.close()
                except Exception as db_e:
                    print(f"[!] Aura DB query error: {db_e}", flush=True)

            # 3. Query Modal Active Containers
            modal_containers = []
            modal_state = "IDLE (Scale-to-Zero - $0.00/s)"
            try:
                m_res = subprocess.run("python -m modal container list", shell=True, capture_output=True, text=True, timeout=5)
                if m_res.returncode == 0:
                    for line in m_res.stdout.splitlines():
                        if "ta-" in line:
                            parts = [p.strip() for p in line.split("|") if p.strip()]
                            if parts:
                                modal_containers.append(parts[0])
                    if modal_containers:
                        modal_state = f"ACTIVE ({len(modal_containers)} container{'s' if len(modal_containers)>1 else ''} running on L40S)"
            except Exception:
                pass

            # 4. Query ITX Log Tail
            log_tail = ""
            try:
                log_file = r"C:\Users\ITX\bot_output.log"
                if os.path.exists(log_file):
                    with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                        lines = f.readlines()
                        log_tail = "".join(lines[-25:])
            except Exception:
                pass

            # Sort tasks strictly by timestamp descending
            tasks_list.sort(key=lambda x: float(x.get("timestamp") or 0.0), reverse=True)

            LATEST_DATA = {
                "timestamp": time.time(),
                "bot_status": {
                    "online": bot_online,
                    "pid": bot_pid,
                    "memory_mb": bot_mem,
                    "node_ip": "192.168.1.152 (ITX Node)"
                },
                "modal_status": {
                    "app_id": "ap-oazJqxY0tayw2OCFhr9NRS",
                    "app_name": "qwen-image-edit-fp8-service",
                    "gpu": "Nvidia L40S (48GB VRAM)",
                    "model": "Qwen 2.5 DiT 20B (Q6_K 6-Bit Master, 15.2 GB)",
                    "active_containers": len(modal_containers),
                    "state": modal_state,
                    "container_ids": modal_containers
                },
                "stats": {
                    "total_users": total_users,
                    "total_generations": total_gens,
                    "total_stars_balance": total_stars,
                    "queue_size": queue_size,
                    "last_duration": 56.8
                },
                "recent_tasks": tasks_list[:50],
                "recent_users": users_list,
                "log_tail": log_tail
            }
        except Exception as e:
            print(f"[!] Error in Aura polling loop: {e}", flush=True)

        time.sleep(3)

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="uk" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aura AI Creative Studio — Live Telemetry & Metrics</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            aura: { 400: '#a855f7', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9' },
            darkbg: '#090d16',
            cardbg: '#111827',
            cardborder: '#1f2937'
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-slow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.85; transform: scale(1.02); } }
    .pulse-glow { animation: pulse-slow 3s infinite ease-in-out; }
    .glass { background: rgba(17, 24, 39, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(31, 41, 55, 0.8); }
    .modal-blur { background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(8px); }
  </style>
</head>
<body class="bg-darkbg text-slate-100 min-h-screen font-sans antialiased p-4 md:p-6">
  <div class="max-w-7xl mx-auto space-y-6">

    <!-- Top Navigation & Header -->
    <header class="glass rounded-2xl p-5 flex flex-wrap justify-between items-center gap-4 shadow-xl border-slate-800">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-tr from-purple-500 to-indigo-600 flex items-center justify-center text-white text-2xl shadow-lg shadow-purple-500/20">
          <i class="fa-solid fa-wand-magic-sparkles"></i>
        </div>
        <div>
          <h1 class="text-xl md:text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-indigo-300 to-purple-200">
            Aura AI Creative Studio & GPU Telemetry
          </h1>
          <p class="text-xs md:text-sm text-slate-400 flex items-center gap-2">
            <span class="text-purple-400 font-semibold">✨ B2C Generative AI Engine</span> • <span>ITX Node (192.168.1.152)</span> • <span>Modal DiT L40S</span> • <span id="clock" class="font-mono text-purple-400"></span>
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live Telemetry (3s)
        </span>
        <button onclick="refreshData()" class="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition border border-slate-700 flex items-center gap-2">
          <i class="fa-solid fa-arrows-rotate" id="refresh-icon"></i> Оновити
        </button>
      </div>
    </header>

    <!-- Top Metric Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      
      <!-- Card 1: Telegram Bot Status -->
      <div class="glass rounded-2xl p-5 border-slate-800 relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Aura Telegram Bot</p>
            <h3 id="bot-status-badge" class="text-lg font-bold mt-1 text-emerald-400 flex items-center gap-2">
              <i class="fa-solid fa-circle-check"></i> 🟢 Online Polling
            </h3>
          </div>
          <div class="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-lg">
            <i class="fa-brands fa-telegram"></i>
          </div>
        </div>
        <div class="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-1">
          <div class="flex justify-between"><span>Node Host:</span> <span class="font-mono text-slate-200">192.168.1.152</span></div>
          <div class="flex justify-between"><span>PID:</span> <span id="bot-pid" class="font-mono text-slate-200">--</span></div>
          <div class="flex justify-between"><span>RAM:</span> <span id="bot-ram" class="font-mono text-slate-200">-- MB</span></div>
        </div>
      </div>

      <!-- Card 2: Modal Cloud DiT GPU Status -->
      <div class="glass rounded-2xl p-5 border-slate-800 relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Modal GPU Engine</p>
            <h3 id="modal-status-badge" class="text-lg font-bold mt-1 text-purple-400 flex items-center gap-2">
              <i class="fa-solid fa-microchip"></i> L40S 48GB (DiT)
            </h3>
          </div>
          <div class="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center text-lg">
            <i class="fa-solid fa-cloud-bolt"></i>
          </div>
        </div>
        <div class="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-1">
          <div class="flex justify-between"><span>Scale-to-Zero:</span> <span id="modal-state" class="font-semibold text-slate-200">Checking...</span></div>
          <div class="flex justify-between"><span>Active GPU Instances:</span> <span id="modal-containers-count" class="font-mono font-bold text-purple-400">0</span></div>
          <div class="flex justify-between"><span>Model Precision:</span> <span class="font-mono text-emerald-400">FP8 / Q6_K Master (20B)</span></div>
        </div>
      </div>

      <!-- Card 3: Performance & Generation Speeds -->
      <div class="glass rounded-2xl p-5 border-slate-800 relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Швидкість генерації</p>
            <h3 class="text-lg font-bold mt-1 text-indigo-400 flex items-center gap-2">
              <i class="fa-solid fa-bolt"></i> ~56-62 с
            </h3>
          </div>
          <div class="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-lg">
            <i class="fa-solid fa-stopwatch"></i>
          </div>
        </div>
        <div class="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-1">
          <div class="flex justify-between"><span>Sampling DiT:</span> <span class="font-mono text-slate-200">2.58 с / step (22 steps)</span></div>
          <div class="flex justify-between"><span>Face Anchoring:</span> <span class="font-mono text-purple-400">100% Zero-Cutout</span></div>
          <div class="flex justify-between"><span>Hot Render:</span> <span class="font-mono text-emerald-400">~56.8 с</span></div>
        </div>
      </div>

      <!-- Card 4: Freemium & Stars Quota -->
      <div class="glass rounded-2xl p-5 border-slate-800 relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Метрики Aura Studio</p>
            <h3 class="text-lg font-bold mt-1 text-amber-400 flex items-center gap-2">
              <i class="fa-solid fa-star"></i> <span id="stat-stars">0</span> Stars
            </h3>
          </div>
          <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center text-lg">
            <i class="fa-solid fa-users"></i>
          </div>
        </div>
        <div class="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400 space-y-1">
          <div class="flex justify-between"><span>Користувачів Aura:</span> <span id="stat-users" class="font-mono text-slate-200 font-bold">0</span></div>
          <div class="flex justify-between"><span>Виконано генерацій:</span> <span id="stat-gens" class="font-mono text-emerald-400 font-bold">0</span></div>
          <div class="flex justify-between"><span>В черзі зараз:</span> <span id="stat-queue" class="font-mono text-purple-400 font-bold">0</span></div>
        </div>
      </div>

    </div>

    <!-- Main Grid: Recent Tasks & Users -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

      <!-- Left Column: Tasks Journal (2 cols) -->
      <div class="lg:col-span-2 glass rounded-2xl p-5 border-slate-800 space-y-4">
        <div class="flex justify-between items-center border-b border-slate-800 pb-3">
          <div>
            <h2 class="text-base font-bold text-slate-200 flex items-center gap-2">
              <i class="fa-solid fa-wand-magic-sparkles text-purple-400"></i> Журнал генерацій Aura Creative Studio
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">💡 Натисніть на будь-який рядок для перегляду фото до/після, промпту та метаданих</p>
          </div>
          <span class="text-xs text-slate-400 font-mono" id="tasks-count-tag">0 tasks</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="bg-slate-900/60 text-slate-400 font-semibold uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th class="p-2.5">Час</th>
                <th class="p-2.5">Користувач</th>
                <th class="p-2.5">Стиль / Пресет</th>
                <th class="p-2.5">Task ID</th>
                <th class="p-2.5">Статус</th>
              </tr>
            </thead>
            <tbody id="tasks-table-body" class="divide-y divide-slate-800/60 font-mono">
              <tr><td colspan="5" class="p-4 text-center text-slate-500 font-sans">Завантаження задач...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Right Column: Users & Quotas (1 col) -->
      <div class="glass rounded-2xl p-5 border-slate-800 space-y-4">
        <div class="flex justify-between items-center border-b border-slate-800 pb-3">
          <h2 class="text-base font-bold text-slate-200 flex items-center gap-2">
            <i class="fa-solid fa-user-shield text-purple-400"></i> Користувачі Aura Studio
          </h2>
          <span class="text-xs text-slate-400 font-mono" id="users-count-tag">0 users</span>
        </div>

        <div id="users-list" class="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
          <div class="p-3 text-center text-xs text-slate-500">Завантаження користувачів...</div>
        </div>
      </div>

    </div>

    <!-- Live Bot Console Logs Stream -->
    <div class="glass rounded-2xl p-5 border-slate-800 space-y-3">
      <div class="flex justify-between items-center border-b border-slate-800 pb-3">
        <h2 class="text-base font-bold text-slate-200 flex items-center gap-2">
          <i class="fa-solid fa-terminal text-emerald-400"></i> Живий потік консолі ITX Node (bot_output.log)
        </h2>
        <span class="text-xs px-2.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">C:\Users\ITX\bot_output.log</span>
      </div>

      <pre id="console-log" class="bg-black/80 rounded-xl p-4 font-mono text-xs text-emerald-400/90 h-44 overflow-y-auto whitespace-pre-wrap border border-slate-800/80 leading-relaxed shadow-inner">Очікування логів...</pre>
    </div>

  </div>

  <!-- Interactive Task Detail Modal Popup -->
  <div id="task-modal" class="fixed inset-0 z-50 flex items-center justify-center p-4 modal-blur hidden" onclick="closeModalOnBackdrop(event)">
    <div class="glass rounded-2xl max-w-4xl w-full p-6 border-slate-700 shadow-2xl space-y-6 relative max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
      
      <!-- Modal Header -->
      <div class="flex justify-between items-start border-b border-slate-800 pb-4">
        <div>
          <div class="flex items-center gap-2.5">
            <span id="modal-bot-type" class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30">✨ Aura Creative Studio</span>
            <h2 id="modal-task-title" class="text-lg font-bold text-slate-100">Деталі генерації</h2>
          </div>
          <p class="text-xs text-slate-400 font-mono mt-1" id="modal-task-id">Task ID: --</p>
        </div>
        <button onclick="closeModal()" class="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- User & Prompt Meta Info -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div class="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <span class="text-slate-400 block mb-1">👤 Користувач:</span>
          <p id="modal-user-info" class="font-bold text-purple-400 text-sm">@username (ID: --)</p>
        </div>
        <div class="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <span class="text-slate-400 block mb-1">🎨 Пресет / Стиль:</span>
          <p id="modal-preset-info" class="font-bold text-indigo-400 text-sm">--</p>
        </div>
        <div class="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
          <span class="text-slate-400 block mb-1">⏱️ Час та статус:</span>
          <p id="modal-status-info" class="font-bold text-emerald-400 text-sm">--</p>
        </div>
      </div>

      <!-- User Prompt Card -->
      <div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1.5">
        <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
          <i class="fa-solid fa-quote-left text-amber-400"></i> Промпт / Інструкція трансформації:
        </span>
        <p id="modal-prompt-text" class="text-xs text-slate-200 font-mono bg-black/40 p-3 rounded-lg border border-slate-800 whitespace-pre-wrap leading-relaxed">
          --
        </p>
      </div>

      <!-- Side-by-Side Before / After Images -->
      <div class="space-y-2">
        <h3 class="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          📸 Порівняння: Оригінальне фото та Результат AI
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          <!-- Original Input Image -->
          <div class="space-y-1.5">
            <div class="flex justify-between items-center text-xs text-slate-400">
              <span>📥 Вхідне фото (Original)</span>
              <a id="modal-input-link" href="#" target="_blank" class="text-purple-400 hover:underline">Відкрити ↗</a>
            </div>
            <div class="aspect-[3/4] rounded-xl bg-black/50 border border-slate-800 overflow-hidden flex items-center justify-center relative group">
              <img id="modal-input-img" src="" alt="Input" class="w-full h-full object-contain" onerror="this.src='https://placehold.co/400x600/1e293b/94a3b8?text=Немає+зображення'" />
            </div>
          </div>

          <!-- Generated Output Image -->
          <div class="space-y-1.5">
            <div class="flex justify-between items-center text-xs text-slate-400">
              <span>✨ Результат AI (Generated)</span>
              <a id="modal-output-link" href="#" target="_blank" class="text-emerald-400 hover:underline">Відкрити ↗</a>
            </div>
            <div class="aspect-[3/4] rounded-xl bg-black/50 border border-slate-800 overflow-hidden flex items-center justify-center relative group">
              <img id="modal-output-img" src="" alt="Result" class="w-full h-full object-contain" onerror="this.src='https://placehold.co/400x600/1e293b/94a3b8?text=Очікування+або+немає+результату'" />
            </div>
          </div>

        </div>
      </div>

    </div>
  </div>

  <script>
    let currentTasks = [];

    function updateClock() {
      const now = new Date();
      document.getElementById('clock').innerText = now.toLocaleTimeString('uk-UA');
    }
    setInterval(updateClock, 1000);
    updateClock();

    async function refreshData() {
      const icon = document.getElementById('refresh-icon');
      icon.classList.add('fa-spin');
      try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
          const data = await res.json();
          renderDashboard(data);
        }
      } catch (e) {
        console.error("Fetch error:", e);
      } finally {
        setTimeout(() => icon.classList.remove('fa-spin'), 600);
      }
    }

    function renderDashboard(data) {
      currentTasks = data.recent_tasks || [];

      // 1. Bot status
      const bot = data.bot_status;
      const bBadge = document.getElementById('bot-status-badge');
      if (bot.online) {
        bBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> 🟢 Online Polling';
        bBadge.className = "text-lg font-bold mt-1 text-emerald-400 flex items-center gap-2";
      } else {
        bBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 🔴 Offline';
        bBadge.className = "text-lg font-bold mt-1 text-rose-400 flex items-center gap-2";
      }
      document.getElementById('bot-pid').innerText = bot.pid ? `#${bot.pid}` : '--';
      document.getElementById('bot-ram').innerText = `${bot.memory_mb} MB`;

      // 2. Modal status
      const modal = data.modal_status;
      document.getElementById('modal-state').innerText = modal.state;
      document.getElementById('modal-containers-count').innerText = modal.active_containers;

      // 3. Stats
      const st = data.stats;
      document.getElementById('stat-users').innerText = st.total_users || 0;
      document.getElementById('stat-gens').innerText = st.total_generations || 0;
      document.getElementById('stat-stars').innerText = st.total_stars_balance || 0;
      document.getElementById('stat-queue').innerText = st.queue_size || 0;

      document.getElementById('tasks-count-tag').innerText = `${currentTasks.length} tasks`;

      // 4. Tasks Table
      const tb = document.getElementById('tasks-table-body');
      if (currentTasks.length > 0) {
        tb.innerHTML = currentTasks.map((t, idx) => {
          let stColor = 'text-slate-400';
          let stIcon = 'fa-circle-question';
          if (t.status === 'COMPLETED') { stColor = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'; stIcon = 'fa-check'; }
          else if (t.status === 'PENDING' || t.status === 'IN_PROGRESS') { stColor = 'text-amber-400 bg-amber-500/10 border-amber-500/20 animate-pulse'; stIcon = 'fa-spinner fa-spin'; }
          else if (t.status === 'EXPIRED' || t.status === 'CANCELLED') { stColor = 'text-slate-500 bg-slate-800 border-slate-700'; stIcon = 'fa-ban'; }

          return `
            <tr onclick="openTaskModal(${idx})" class="hover:bg-slate-800/60 cursor-pointer transition group">
              <td class="p-2.5 text-slate-400 group-hover:text-slate-200">${t.time}</td>
              <td class="p-2.5">
                <span class="text-purple-400 font-bold block">@${t.username || t.user_id}</span>
                <span class="text-[10px] text-slate-500 font-mono">ID: ${t.user_id}</span>
              </td>
              <td class="p-2.5">
                <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  ✨ ${t.preset_id}
                </span>
              </td>
              <td class="p-2.5 text-slate-400 text-[11px] truncate max-w-[140px] font-mono">${t.task_id}</td>
              <td class="p-2.5">
                <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold border ${stColor}">
                  <i class="fa-solid ${stIcon}"></i> ${t.status}
                </span>
              </td>
            </tr>
          `;
        }).join('');
      } else {
        tb.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-slate-500 font-sans">Немає останніх завдань у студії Aura</td></tr>';
      }

      // 5. Users List
      const targetUsers = data.recent_users || [];
      document.getElementById('users-count-tag').innerText = `${targetUsers.length} users`;

      const ul = document.getElementById('users-list');
      if (targetUsers.length > 0) {
        ul.innerHTML = targetUsers.map(u => {
          const isAdmin = Boolean(u.is_admin);
          return `
            <div class="p-3 rounded-xl bg-slate-900/60 border border-slate-800 flex justify-between items-center text-xs">
              <div>
                <p class="font-bold text-slate-200 flex items-center gap-1.5">
                  ${isAdmin ? '<i class="fa-solid fa-crown text-amber-400"></i>' : '<i class="fa-solid fa-wand-magic-sparkles text-purple-400"></i>'}
                  @${u.username}
                </p>
                <p class="text-[11px] text-slate-500 font-mono">ID: ${u.user_id}</p>
              </div>
              <div class="text-right space-y-0.5 font-mono">
                <p class="${isAdmin ? 'text-amber-400 font-bold' : (u.free_left > 0 ? 'text-emerald-400' : 'text-rose-400')}">
                  ${isAdmin ? '∞ Unlimited' : `${u.free_left} free left`}
                </p>
                <p class="text-[11px] text-slate-400">${u.stars_balance} ⭐ Stars</p>
              </div>
            </div>
          `;
        }).join('');
      } else {
        ul.innerHTML = '<div class="p-4 text-center text-xs text-slate-500">Немає зареєстрованих користувачів</div>';
      }

      // 6. Console Log Tail
      if (data.log_tail) {
        const clog = document.getElementById('console-log');
        clog.innerText = data.log_tail;
        clog.scrollTop = clog.scrollHeight;
      }
    }

    // Modal Details Viewer Logic
    function openTaskModal(idx) {
      const t = currentTasks[idx];
      if (!t) return;

      document.getElementById('modal-task-title').innerText = `Генерація: ${t.preset_id}`;
      document.getElementById('modal-task-id').innerText = `Task ID: ${t.task_id}`;
      document.getElementById('modal-user-info').innerText = `@${t.username || t.user_id} (ID: ${t.user_id})`;
      document.getElementById('modal-preset-info').innerText = t.preset_id || "Custom Style";
      document.getElementById('modal-status-info').innerText = `${t.time} • ${t.status}`;
      document.getElementById('modal-prompt-text').innerText = t.prompt || "Стандартний системний пресет.";

      const inImg = document.getElementById('modal-input-img');
      const outImg = document.getElementById('modal-output-img');
      const inLink = document.getElementById('modal-input-link');
      const outLink = document.getElementById('modal-output-link');

      if (t.input_url) {
        inImg.src = t.input_url;
        inLink.href = t.input_url;
      } else {
        inImg.src = '';
        inLink.href = '#';
      }

      if (t.output_url) {
        outImg.src = t.output_url;
        outLink.href = t.output_url;
      } else {
        outImg.src = '';
        outLink.href = '#';
      }

      document.getElementById('task-modal').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('task-modal').classList.add('hidden');
    }

    function closeModalOnBackdrop(e) {
      if (e.target.id === 'task-modal') {
        closeModal();
      }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Auto-poll every 3 seconds
    setInterval(refreshData, 3000);
    refreshData();
  </script>
</body>
</html>
"""

class MonitoringHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/telemetry":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(LATEST_DATA).encode("utf-8"))
        elif parsed.path == "/api/image":
            img_type = qs.get("type", [""])[0]
            task_id = qs.get("task_id", [""])[0].strip()
            
            filepath = None
            if img_type == "creative_input":
                cand = os.path.join(r"D:\AI_Workspace\ComfyUI\creative_bot_temp\inputs", f"{task_id}.jpg")
                if os.path.exists(cand): filepath = cand
            elif img_type == "creative_output":
                for ext in ["_result.png", "_result.jpg", ".png", ".jpg"]:
                    cand = os.path.join(r"D:\AI_Workspace\ComfyUI\creative_bot_temp\outputs", f"{task_id}{ext}")
                    if os.path.exists(cand):
                        filepath = cand
                        break

            if filepath and os.path.exists(filepath):
                self.send_response(200)
                mime = "image/png" if filepath.endswith(".png") else "image/jpeg"
                self.send_header("Content-Type", mime)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                with open(filepath, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.send_response(404)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Image not found")
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode("utf-8"))

    def log_message(self, format, *args):
        pass

def start_server():
    poller = threading.Thread(target=poll_aura_state, daemon=True)
    poller.start()

    with socketserver.ThreadingTCPServer(("", PORT), MonitoringHandler) as httpd:
        print("=" * 65, flush=True)
        print(f"🚀 Aura AI Creative Studio Dashboard is Active on Port {PORT}!", flush=True)
        print(f"🔗 Open in Browser: http://localhost:{PORT} or http://127.0.0.1:{PORT}", flush=True)
        print("=" * 65, flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping dashboard server...")

if __name__ == "__main__":
    start_server()
