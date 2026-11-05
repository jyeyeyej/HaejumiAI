export async function claimCreatorRenderJob(pool, jobId) {
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('VALIDATION_ERROR');
  }

  return withRenderTransaction(pool, async (client) => {
    const { job, task } = await lockRenderContext(client, jobId);

    if (job.status !== 'queued') return null;

    if (
      task.current_version !== job.content_version ||
      task.content_hash !== job.content_hash
    ) {
      throw new Error('VERSION_CONFLICT');
    }

    const result = await client.query(
      `UPDATE haejumi_dev.creator_render_jobs
       SET status = 'running',
           job_data = COALESCE(job_data, '{}'::jsonb)
             || jsonb_build_object(
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

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = 'rendering',
           task_data = COALESCE(task_data, '{}'::jsonb)
             || '{"progress_percent":5}'::jsonb,
           updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id]
    );

    return result.rows[0] ?? null;
  });
}

import { randomUUID } from 'node:crypto';

// PostgreSQL 트랜잭션 공통 처리
async function withRenderTransaction(pool, action) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await action(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 렌더링 작업 및 관련 데이터 잠금
async function lockRenderContext(client, jobId) {
  const jobs = await client.query(
    `SELECT * FROM haejumi_dev.creator_render_jobs
     WHERE job_id = $1 FOR UPDATE`,
    [jobId]
  );

  const job = jobs.rows[0];
  if (!job) throw new Error('RESOURCE_NOT_FOUND');

  const tasks = await client.query(
    `SELECT * FROM haejumi_dev.creator_tasks
     WHERE task_id = $1 FOR UPDATE`,
    [job.task_id]
  );

  const task = tasks.rows[0];
  if (!task || task.owner_id !== job.owner_id) {
    throw new Error('RESOURCE_NOT_FOUND');
  }

  const projects = await client.query(
    `SELECT * FROM haejumi_dev.creator_projects
     WHERE project_id = $1 FOR UPDATE`,
    [task.project_id]
  );

  const project = projects.rows[0];
  if (!project || project.owner_id !== job.owner_id) {
    throw new Error('RESOURCE_NOT_FOUND');
  }
if (
  task.task_data?.active_job_id !== jobId
) {
  throw new Error('VERSION_CONFLICT');
}
  return { job, task, project };
}

// 렌더링 완료
// validatedResult는 영상 파일 검증을 통과한 결과만 전달해야 합니다.
export async function finishCreatorRenderJob(
  pool,
  jobId,
  validatedResult
) {
  if (
    !validatedResult ||
    !['succeeded', 'simulated'].includes(validatedResult.status) ||
    !['ffmpeg', 'test'].includes(validatedResult.renderer_mode) ||
    (validatedResult.status === 'succeeded' &&
      (validatedResult.renderer_mode !== 'ffmpeg' ||
       validatedResult.artifact_verified !== true)) ||
    (validatedResult.status === 'simulated' &&
      validatedResult.renderer_mode !== 'test') ||
    typeof validatedResult.artifact_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(validatedResult.artifact_sha256) ||
    typeof validatedResult.artifact_key !== 'string' ||
    !validatedResult.artifact_key
  ) {
    throw new Error('RENDER_VALIDATION_FAILED');
  }

  return withRenderTransaction(pool, async (client) => {
    const { job, task } = await lockRenderContext(client, jobId);

    if (job.status !== 'running') return job;

    if (
      task.current_version !== job.content_version ||
      task.content_hash !== job.content_hash ||
      (task.task_data?.active_job_id &&
        task.task_data.active_job_id !== jobId)
    ) {
      throw new Error('VERSION_CONFLICT');
    }

    const simulated = validatedResult.status === 'simulated';
    const nextStatus = simulated
      ? 'render_simulated'
      : 'waiting_preview_approval';

    const jobResult = await client.query(
      `UPDATE haejumi_dev.creator_render_jobs
       SET status = $2,
           job_data = COALESCE(job_data, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE job_id = $1
       RETURNING *`,
      [
        jobId,
        validatedResult.status,
        JSON.stringify({
          ...validatedResult,
          progress_percent: 100,
          completed_at: new Date().toISOString()
        })
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = $2,
           task_data =
             (COALESCE(task_data, '{}'::jsonb) - 'active_job_id')
             || $3::jsonb,
           updated_at = NOW()
       WHERE task_id = $1`,
      [
        task.task_id,
        nextStatus,
        JSON.stringify({
          progress_percent: 100,
          next_action: simulated ? 'none' : 'review_preview',
          artifact_sha256: validatedResult.artifact_sha256
        })
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_projects
       SET status = 'review_required',
           updated_at = NOW()
       WHERE project_id = $1`,
      [task.project_id]
    );

    if (!simulated) {
      await client.query(
        `INSERT INTO haejumi_dev.creator_checkpoints
         (checkpoint_id, task_id, owner_id, kind,
          status, content_version, content_hash, checkpoint_data)
         VALUES ($1, $2, $3, 'preview',
                 'pending', $4, $5, $6::jsonb)`,
        [
          randomUUID(),
          task.task_id,
          task.owner_id,
          task.current_version,
          task.content_hash,
          JSON.stringify({
            approval_scope: 'continue',
            summary: 'ffprobe 검증을 통과한 비공개 미리보기를 확인해 주세요.'
          })
        ]
      );
    }

    return jobResult.rows[0];
  });
}

// 렌더링 실패
export async function failCreatorRenderJob(
  pool,
  jobId,
  errorCode = 'RENDER_FAILED'
) {
  const safeCodes = new Set([
    'RENDER_FAILED',
    'RENDER_VALIDATION_FAILED',
    'FFMPEG_UNAVAILABLE',
    'FFPROBE_UNAVAILABLE',
    'UNSUPPORTED_MEDIA_TYPE',
    'VALIDATION_ERROR',
    'RESOURCE_NOT_FOUND',
    'WORKER_INTERRUPTED',
    'VERSION_CONFLICT'
  ]);

  return withRenderTransaction(pool, async (client) => {
    const { job, task } = await lockRenderContext(client, jobId);

    if (!['queued', 'running'].includes(job.status)) return job;

    const result = await client.query(
      `UPDATE haejumi_dev.creator_render_jobs
       SET status = 'failed',
           job_data = COALESCE(job_data, '{}'::jsonb)
             || $2::jsonb,
           updated_at = NOW()
       WHERE job_id = $1
       RETURNING *`,
      [
        jobId,
        JSON.stringify({
          safe_error_code: safeCodes.has(errorCode)
            ? errorCode
            : 'RENDER_FAILED',
          completed_at: new Date().toISOString()
        })
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = 'failed',
           task_data = COALESCE(task_data, '{}'::jsonb)
             - 'active_job_id',
           updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_projects
       SET status = 'failed',
           updated_at = NOW()
       WHERE project_id = $1`,
      [task.project_id]
    );

    return result.rows[0];
  });
}

// 사용자 렌더링 취소
export async function cancelCreatorRenderJob(
  pool,
  ownerId,
  jobId
) {
  return withRenderTransaction(pool, async (client) => {
    const { job, task } = await lockRenderContext(client, jobId);

    if (job.owner_id !== ownerId) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    if (job.status === 'cancelled') return job;

    if (!['queued', 'running'].includes(job.status)) {
      throw new Error('INVALID_STATE_TRANSITION');
    }

    const result = await client.query(
      `UPDATE haejumi_dev.creator_render_jobs
       SET status = 'cancelled',
           job_data =
             (COALESCE(job_data, '{}'::jsonb)
               - 'safe_error_code')
             || $2::jsonb,
           updated_at = NOW()
       WHERE job_id = $1
       RETURNING *`,
      [
        jobId,
        JSON.stringify({
          completed_at: new Date().toISOString()
        })
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = 'render_ready',
           task_data =
             (COALESCE(task_data, '{}'::jsonb)
               - 'active_job_id')
             || '{"progress_percent":0,"next_action":"none"}'::jsonb,
           updated_at = NOW()
       WHERE task_id = $1`,
      [task.task_id]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_projects
       SET status = 'created',
           updated_at = NOW()
       WHERE project_id = $1`,
      [task.project_id]
    );

    return result.rows[0];
  });
}

// 서버 중단 후 미완료 작업 복구
export async function recoverInterruptedCreatorRenders(pool) {
  const running = await pool.query(
    `SELECT job_id
     FROM haejumi_dev.creator_render_jobs
     WHERE status = 'running'
     ORDER BY created_at`
  );

  let recovered = 0;

  for (const row of running.rows) {
    const result = await failCreatorRenderJob(
      pool,
      row.job_id,
      'WORKER_INTERRUPTED'
    );

    if (result.status === 'failed') recovered++;
  }

  return { recovered };
}
