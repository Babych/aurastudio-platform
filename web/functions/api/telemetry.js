// Cloudflare Pages Function: /api/telemetry (Ingest telemetry from Bots and Web)

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        const { event_type, source, user_id, duration_seconds, stars_amount, usd_amount, details } = body;

        if (env.DB) {
            await env.DB.prepare(`
                INSERT INTO telemetry_events (event_type, source, user_id, duration_seconds, stars_amount, usd_amount, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(
                event_type || 'GENERATION_SUCCESS',
                source || 'telegram_bot',
                user_id ? String(user_id) : 'unknown',
                duration_seconds || 0.0,
                stars_amount || 0,
                usd_amount || 0.0,
                details ? JSON.stringify(details) : null
            ).run();
        }

        return new Response(JSON.stringify({ status: "success", ingested: true }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
