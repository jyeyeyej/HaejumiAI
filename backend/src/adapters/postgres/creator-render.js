export async function claimCreatorRenderJob(pool, jobId) {
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('VALIDATION_ERROR');
  }

  const result = await pool.query(
    `UPDATE haejumi_dev.creator_render_jobs
     SET status = 'running',
         job_data = job_data || jsonb_build_object(
           'status', 'running',
           'progress_percent', 5,
           'started_at', NOW()
         ),
         updated_at = NOW()
     WHERE job_id = $1
       AND status = 'queued'
     RETURNING *`,
    [jobId]
  );

  return result.rows[0] ?? null;
}