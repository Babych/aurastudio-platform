// Cloudflare Pages Function: /api/stats (Real-time Monitoring Dashboard API)

export async function onRequestGet(context) {
    const { env } = context;

    try {
        if (!env.DB) {
            // Mock fallback if D1 binding is not yet attached during local preview
            return new Response(JSON.stringify({
                status: "mock",
                total_users: 142,
                total_generations: 589,
                total_stars: 2850,
                total_usd: 189.90,
                avg_duration: 32.4,
                modal_status: "READY (A10G 24GB)",
                recent_tasks: [
                    { id: "task-9812", source: "web", preset: "💼 LinkedIn Pro", status: "SUCCESS", duration: 31.2, time: "2 хв тому" },
                    { id: "task-9811", source: "telegram", preset: "🍸 Old Money", status: "SUCCESS", duration: 29.8, time: "5 хв тому" },
                    { id: "task-9810", source: "telegram", preset: "🏖️ Bali Beach", status: "SUCCESS", duration: 33.1, time: "11 хв тому" }
                ]
            }), {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
        }

        // Live queries from Cloudflare D1
        const usersCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();
        const gensStats = await env.DB.prepare(`
            SELECT 
                COUNT(*) as total_gens,
                AVG(duration_seconds) as avg_duration,
                SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as successful_gens
            FROM generations
        `).first();

        const revenueStats = await env.DB.prepare(`
            SELECT 
                SUM(stars_amount) as total_stars,
                SUM(usd_amount) as total_usd
            FROM telemetry_events
        `).first();

        const recentTasks = await env.DB.prepare(`
            SELECT id, source, preset_id as preset, status, duration_seconds as duration, created_at
            FROM generations
            ORDER BY created_at DESC
            LIMIT 10
        `).all();

        return new Response(JSON.stringify({
            status: "success",
            total_users: usersCount?.count || 0,
            total_generations: gensStats?.total_gens || 0,
            successful_generations: gensStats?.successful_gens || 0,
            total_stars: revenueStats?.total_stars || 0,
            total_usd: revenueStats?.total_usd || 0.0,
            avg_duration: Number(gensStats?.avg_duration || 32.0).toFixed(1),
            modal_status: "READY (Nvidia A10G 24GB)",
            recent_tasks: recentTasks?.results || []
        }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
