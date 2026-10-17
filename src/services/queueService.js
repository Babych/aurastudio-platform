import { MODAL_ASYNC_ENDPOINTS } from "../config/constants.js";
import { pollModalTaskStatus } from "./gpuService.js";
import { recordGenerationInD1 } from "./dbService.js";

export async function getLiveQueueStatus(env) {
  let activeJobs = 0;
  let isWarm = false;
  let secondsSinceLast = null;

  if (env && env.DB) {
    try {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) as count 
        FROM generations 
        WHERE status IN ('PROCESSING', 'PENDING') 
          AND (strftime('%s', 'now') - strftime('%s', created_at)) < 300
      `).first();
      activeJobs = (row && row.count) || 0;

      const lastGen = await env.DB.prepare(`
        SELECT CAST((strftime('%s', 'now') - strftime('%s', created_at)) AS INTEGER) as seconds_ago
        FROM generations
        WHERE status = 'SUCCESS'
        ORDER BY created_at DESC
        LIMIT 1
      `).first();

      if (lastGen && typeof lastGen.seconds_ago === 'number') {
        secondsSinceLast = lastGen.seconds_ago;
        // Modal scaledown_window is 300s (5 minutes). If last generation was within 290s, container is warm!
        isWarm = lastGen.seconds_ago <= 290;
      }
    } catch(e) {
      console.error("Queue status query error:", e);
    }
  }

  const position = activeJobs + 1;
  const baseEta = isWarm ? 22 : 160;
  const etaSeconds = baseEta * position;

  return {
    status: "success",
    active_jobs: activeJobs,
    queue_position: position,
    is_warm: isWarm,
    seconds_since_last: secondsSinceLast,
    estimated_seconds: etaSeconds,
    cluster: isWarm ? "Modal Nvidia L40S 48GB (Hot / Ready)" : "Modal Nvidia L40S (Cold Start)"
  };
}

export async function getTaskStatus(env, taskId, origin) {
  if (!env || !env.DB) {
    return { status: "error", message: "Database not bound" };
  }

  const task = await env.DB.prepare(`
    SELECT * FROM generations WHERE id = ? OR share_token = ?
  `).bind(taskId, taskId).first();

  if (!task) {
    return { status: "not_found" };
  }

  if (task.status === "SUCCESS") {
    return {
      status: "success",
      task_id: task.id,
      share_token: task.share_token,
      share_url: `${origin}/s/${task.share_token || task.id}`,
      output_image_url: task.output_image_url,
      duration_seconds: task.duration_seconds
    };
  }

  if (task.status === "FAILED") {
    return {
      status: "failed",
      error: task.error_message || "Generation failed"
    };
  }

  // If task is still PROCESSING, poll Modal cluster for real-time completion
  if (task.status === "PROCESSING") {
    let modalEndpoint = null;
    if (task.error_message && task.error_message.startsWith("modal_endpoint:")) {
      modalEndpoint = task.error_message.replace("modal_endpoint:", "").trim();
    } else {
      modalEndpoint = MODAL_ASYNC_ENDPOINTS[0].status;
    }

    try {
      const modalRes = await pollModalTaskStatus(modalEndpoint, task.id, env.MODAL_AUTH_KEY);
      if (modalRes && modalRes.status === "success" && modalRes.result_base64) {
        let resultDataUri = modalRes.result_base64.startsWith("data:")
          ? modalRes.result_base64
          : `data:image/png;base64,${modalRes.result_base64}`;

        await recordGenerationInD1(env, {
          id: task.id,
          userId: task.user_id,
          source: task.source || 'web',
          presetId: task.preset_id,
          prompt: task.prompt,
          inputBase64: task.input_image_url,
          outputBase64: resultDataUri,
          duration: modalRes.duration_seconds || 45,
          status: 'SUCCESS'
        });

        return {
          status: "success",
          task_id: task.id,
          share_token: task.share_token,
          share_url: `${origin}/s/${task.share_token || task.id}`,
          output_image_url: resultDataUri,
          duration_seconds: modalRes.duration_seconds || 45
        };
      } else if (modalRes && modalRes.status === "failed") {
        await env.DB.prepare("UPDATE generations SET status = 'FAILED', error_message = ? WHERE id = ?").bind(modalRes.error || "Generation failed on GPU cluster", task.id).run().catch(() => {});
        return {
          status: "failed",
          error: modalRes.error || "Generation failed on GPU cluster"
        };
      }
    } catch(mErr) {
      console.error("Modal status poll error:", mErr);
    }

    // Auto-expire if processing for > 600s
    if (task.created_at) {
      const createdDate = new Date(task.created_at.includes("Z") ? task.created_at : task.created_at + "Z").getTime();
      if (Date.now() - createdDate > 600000) {
        await env.DB.prepare("UPDATE generations SET status = 'FAILED', error_message = 'Generation timed out' WHERE id = ?").bind(task.id).run().catch(() => {});
        return {
          status: "failed",
          error: "Generation timed out"
        };
      }
    }
  }

  // Active or pending queue position
  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM generations 
    WHERE status IN ('PROCESSING', 'PENDING') AND created_at < ?
  `).bind(task.created_at).first();
  const pos = ((countRow && countRow.count) || 0) + 1;

  return {
    status: task.status,
    task_id: task.id,
    queue_position: pos,
    estimated_seconds: pos * 22
  };
}
