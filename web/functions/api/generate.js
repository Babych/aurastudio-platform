// Cloudflare Pages Function: /api/generate (Image Generation via Modal A10G)

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const body = await request.json();
        const { image_base64, prompt, preset_id, user_id } = body;

        if (!image_base64 || !prompt) {
            return new Response(JSON.stringify({ status: "error", message: "image_base64 and prompt are required" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        const modalEndpoints = [
            "https://dmytrobbch--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run",
            env.MODAL_ENDPOINT_URL || "https://memory1024--qwen-image-edit-fp8-service-qweneditorfp8-api-edit.modal.run"
        ];
        const taskId = `web_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const smoothNegative = "textured fabric, pattern, tweed, speckles, flecks, lint, dots on fabric, dotted texture, fabric dots, moles, excessive moles, freckles, skin spots, blemishes, noisy skin, speckled, dithering, salt and pepper noise, textured grain, pattern dots, text, words, letters, font, typography, watermark, signature, caption, logo, brand, poster, title, label, changed face, altered eyes, blurry face, different identity, fake skin, plastic wax, doll, airbrushed skin, deformed face, bad eyes, cartoon, deformed, blurry";

        const payload = {
            image_base64: image_base64.replace(/^data:image\/\w+;base64,/, ""),
            prompt: prompt,
            negative_prompt: smoothNegative,
            steps: 22,
            cfg: 1.95,
            seed: 888424
        };

        const t0 = Date.now();
        let modalResp = null;
        let lastErr = "";

        for (const endpoint of modalEndpoints) {
            try {
                modalResp = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (modalResp.ok) break;
                lastErr = await modalResp.text();
            } catch (e) {
                lastErr = e.message;
            }
        }

        const dur = ((Date.now() - t0) / 1000).toFixed(1);

        if (!modalResp.ok) {
            const errText = await modalResp.text();
            throw new Error(`Modal GPU Error (${modalResp.status}): ${errText.substring(0, 200)}`);
        }

        const modalData = await modalResp.json();
        if (modalData.status !== "success") {
            throw new Error(modalData.error || "Generation failed on Modal GPU");
        }

        const resultBase64 = `data:image/png;base64,${modalData.result_base64}`;

        // Asynchronously save to D1 database if bound
        if (env.DB) {
            context.waitUntil(
                env.DB.prepare(`
                    INSERT INTO generations (id, user_id, source, preset_id, prompt, input_image_url, output_image_url, status, duration_seconds)
                    VALUES (?, ?, 'web', ?, ?, 'uploaded_base64', 'result_base64', 'SUCCESS', ?)
                `).bind(taskId, user_id || "anonymous_web", preset_id || "custom", prompt, parseFloat(dur)).run()
            );
        }

        return new Response(JSON.stringify({
            status: "success",
            task_id: taskId,
            duration_seconds: parseFloat(dur),
            result_base64: resultBase64
        }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
    }
}
