// Real-time Queue Tracking & Task Status Service (Midjourney / Leonardo style)

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
  const baseEta = isWarm ? 22 : 78;
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
