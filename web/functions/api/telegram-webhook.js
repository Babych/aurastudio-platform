// Cloudflare Pages Function: /api/telegram-webhook
// Serverless 24/7 Telegram Bot Handler for @AuraStudioAiBot

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const update = await request.json();
        const botToken = env.AURA_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
        if (!botToken) throw new Error("Bot token secret not configured");

        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = msg.text || "";

            if (text.startsWith("/start")) {
                const welcomeText = 
                    "✨ *Вітаємо в AuraStudio AI!* ✨\n\n" +
                    "🎨 *Студійні бізнес-портрети, стиль та повна зміна фото за 30 секунд!*\n\n" +
                    "• 📸 *LinkedIn Pro Headshot* — ділові фото без фотостудії\n" +
                    "• 👗 *Old Money & Fashion* — примірка дизайнерського одягу\n" +
                    "• 🌴 *Travel Teleport* — перенесення на Балі, в Париж чи Дубай\n\n" +
                    "👇 *Відкрийте наш веб-додаток або надішліть фото сюди:*";

                const webAppUrl = env.WEB_APP_URL || "https://aurastudio-ai.pages.dev";

                const keyboard = {
                    inline_keyboard: [
                        [{ text: "✨ Відкрити AI Студію (Web App)", web_app: { url: webAppUrl } }],
                        [{ text: "🌐 Відкрити сайт", url: webAppUrl }]
                    ]
                };

                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: welcomeText,
                        parse_mode: "Markdown",
                        reply_markup: keyboard
                    })
                });
            }
        }

        return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" }
        });

    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 200, // Always return 200 to Telegram so it doesn't retry endlessly
            headers: { "Content-Type": "application/json" }
        });
    }
}
