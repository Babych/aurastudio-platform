// Route Handler: Public Social Share Landing Page & Image Proxy

export async function handleShareImage(request, env, url) {
  const match = url.pathname.match(/\/api\/image\/([^./]+)/);
  if (match && env.DB) {
    const idOrToken = match[1];
    const row = await env.DB.prepare(
      "SELECT output_image_url FROM generations WHERE id = ? OR share_token = ?"
    ).bind(idOrToken, idOrToken).first();

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

export async function handleSharePage(request, env, url) {
  const token = url.pathname.replace(/^\/(s|share)\//, "").split("/")[0];
  let task = null;
  if (env.DB && token) {
    task = await env.DB.prepare(
      "SELECT * FROM generations WHERE share_token = ? OR id = ?"
    ).bind(token, token).first();
  }

  if (!task || !task.output_image_url) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Photo Not Found — AuraStudio.AI</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen flex flex-col items-center justify-center p-6 text-center antialiased font-sans">
  <div class="bg-white p-8 rounded-3xl shadow-xl border border-slate-200 max-w-md w-full space-y-4">
    <div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto text-xl">✨</div>
    <h2 class="text-xl font-bold text-slate-900">Photo Not Found or Expired</h2>
    <p class="text-sm text-slate-500">This photo may have been removed or the share link has expired.</p>
    <a href="/" class="inline-block px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-sm transition shadow-sm">
      Create Your Own at AuraStudio.AI &rarr;
    </a>
  </div>
</body>
</html>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      }
    );
  }

  const origin = url.origin;
  const imageUrl = `${origin}/api/image/${task.share_token || task.id}.png`;
  const sharePageUrl = `${origin}/s/${token}`;
  const presetLabel = task.preset_id ? task.preset_id.replace(/_/g, " ").toUpperCase() : "STUDIO AI TRANSFORMATION";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Transformation by AuraStudio — ${presetLabel}</title>
    <meta name="description" content="Check out this AI transformation created with AuraStudio.AI! Try 5 free generations daily.">

    <!-- Open Graph (Facebook / Discord / Telegram) -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${sharePageUrl}">
    <meta property="og:title" content="AI Transformation — AuraStudio.AI">
    <meta property="og:description" content="Studio-grade portraits, LinkedIn headshots, and styling in 25s. Try 5 free daily!">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:width" content="1024">
    <meta property="og:image:height" content="1024">

    <!-- Twitter / X Card Meta Tags -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:site" content="@AuraStudioAi">
    <meta name="twitter:title" content="AI Transformation with AuraStudio.AI">
    <meta name="twitter:description" content="Created with Qwen 2.5 DiT. Try 5 free transformations daily!">
    <meta name="twitter:image" content="${imageUrl}">

    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen flex flex-col justify-between items-center p-4 sm:p-8 antialiased">
    <!-- Header -->
    <header class="w-full max-w-2xl flex items-center justify-between py-3">
        <a href="/" class="flex items-center gap-2.5 font-extrabold text-xl tracking-tight text-slate-900 hover:opacity-85 transition">
            <span class="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center text-white text-sm shadow-md shadow-indigo-500/20">✨</span>
            <span>AuraStudio<span class="text-indigo-600">.AI</span></span>
        </a>
        <a href="/" class="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl shadow-sm transition">
            Try 5 Free
        </a>
    </header>

    <!-- Main Content -->
    <main class="w-full max-w-lg my-auto py-6 space-y-6">
        <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-xl shadow-slate-200/60 border border-slate-200/80">
            <div class="relative rounded-2xl overflow-hidden bg-slate-100 flex items-center justify-center min-h-[300px] max-h-[75vh]">
                <img src="${task.output_image_url}" alt="AI Result" class="w-full h-auto max-h-[75vh] object-contain rounded-2xl">
                <div class="absolute top-3 left-3 px-3 py-1 rounded-full bg-white/95 backdrop-blur text-xs font-bold text-indigo-700 border border-slate-200 shadow-sm flex items-center gap-1.5">
                    <span class="w-2 h-2 rounded-full bg-indigo-600 animate-pulse"></span>
                    ✨ ${presetLabel}
                </div>
            </div>

            <!-- Share Page Action Bar -->
            <div class="flex items-center gap-2 mt-4 pt-4 border-t border-slate-100">
                <a href="${task.output_image_url}" download="AuraStudio_${task.share_token || task.id}.png" class="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition text-center flex items-center justify-center gap-1.5">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    Download HD
                </a>
                <button onclick="copyShareLink()" class="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition flex items-center justify-center gap-1.5">
                    <svg class="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                    <span id="copyBtnLabel">Copy Link</span>
                </button>
            </div>
        </div>

        <div class="space-y-3 text-center">
            <a href="/" class="w-full py-4 bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 text-white font-bold rounded-2xl shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2 text-base transition">
                <span>⚡ Transform Your Own Photo Free</span>
            </a>
            <p class="text-xs text-slate-500">No credit card required • 5 Free generations daily</p>
        </div>
    </main>

    <!-- Footer -->
    <footer class="w-full max-w-2xl text-center py-6 text-xs text-slate-500 border-t border-slate-200 mt-8">
        Powered by Qwen 2.5 DiT Engine • <a href="/" class="text-indigo-600 hover:underline font-semibold">AuraStudio.AI</a>
    </footer>

    <script>
        function copyShareLink() {
            navigator.clipboard.writeText(window.location.href).then(() => {
                const el = document.getElementById('copyBtnLabel');
                if (el) {
                    el.innerText = 'Copied! ✓';
                    setTimeout(() => { el.innerText = 'Copy Link'; }, 2000);
                }
            }).catch(() => {
                prompt('Share link:', window.location.href);
            });
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
