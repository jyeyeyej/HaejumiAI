import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import {
  claimCreatorRenderJob,
  finishCreatorRenderJob,
  failCreatorRenderJob,
  cancelCreatorRenderJob,
  recoverInterruptedCreatorRenders
} from './creator-render.js';

const pool = createPostgresPool();
const ownerId = `render-lifecycle-test-${randomUUID()}`;
const created = [];

async function createFixture() {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const jobId = randomUUID();
  const hash = `test-hash-${randomUUID()}`;

  // 프로젝트의 task_id와 작업의 project_id가 서로 참조하므로
  // 프로젝트를 먼저 만든 후 task_id를 연결합니다.
  await pool.query(
  `INSERT INTO haejumi_dev.creator_projects
   (project_id, owner_id, task_id, status, current_version, content_hash)
   VALUES ($1, $2, $3, 'rendering', 1, $4)`,
  [projectId, ownerId, taskId, hash]
);

  created.push({ projectId, taskId, jobId });

  await pool.query(
    `INSERT INTO haejumi_dev.creator_tasks
     (task_id, project_id, owner_id, status,
      current_version, content_hash, task_data)
     VALUES ($1, $2, $3, 'rendering', 1, $4, $5::jsonb)`,
    [
      taskId, projectId, ownerId, hash,
      JSON.stringify({ active_job_id: jobId })
    ]
  );

  await pool.query(
    `UPDATE haejumi_dev.creator_projects
     SET task_id = $2 WHERE project_id = $1`,
    [projectId, taskId]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_render_jobs
     (job_id, task_id, owner_id, status,
      content_version, content_hash)
     VALUES ($1, $2, $3, 'queued', 1, $4)`,
    [jobId, taskId, ownerId, hash]
  );

  return { projectId, taskId, jobId, hash };
}

try {
  // 1. 완료 처리
  const success = await createFixture();
  assert.equal(
    (await claimCreatorRenderJob(pool, success.jobId)).status,
    'running'
  );

  const completed = await finishCreatorRenderJob(
    pool,
    success.jobId,
    {
      status: 'succeeded',
      renderer_mode: 'ffmpeg',
      artifact_verified: true,
      artifact_sha256: 'a'.repeat(64),
      artifact_key: 'synthetic-test.mp4'
    }
  );

  assert.equal(completed.status, 'succeeded');

  const preview = await pool.query(
    `SELECT * FROM haejumi_dev.creator_checkpoints
     WHERE task_id = $1 AND kind = 'preview'`,
    [success.taskId]
  );
  assert.equal(preview.rowCount, 1);
  console.log('1. Render completion and preview checkpoint: PASS');

  // 2. 실패 처리
  const failure = await createFixture();
  await claimCreatorRenderJob(pool, failure.jobId);
  const failed = await failCreatorRenderJob(
    pool, failure.jobId, 'RENDER_FAILED'
  );
  assert.equal(failed.status, 'failed');
  console.log('2. Render failure: PASS');

  // 3. 취소 처리
  const cancellation = await createFixture();
  const cancelled = await cancelCreatorRenderJob(
    pool, ownerId, cancellation.jobId
  );
  assert.equal(cancelled.status, 'cancelled');
  console.log('3. Render cancellation: PASS');

  // 4. 중단된 렌더링 작업 복구
  const interrupted = await createFixture();
  await claimCreatorRenderJob(pool, interrupted.jobId);
  const recovery = await recoverInterruptedCreatorRenders(pool);
  assert.ok(recovery.recovered >= 1);

  const recovered = await pool.query(
    `SELECT status, job_data
     FROM haejumi_dev.creator_render_jobs
     WHERE job_id = $1`,
    [interrupted.jobId]
  );
  assert.equal(recovered.rows[0].status, 'failed');
  assert.equal(
    recovered.rows[0].job_data.safe_error_code,
    'WORKER_INTERRUPTED'
  );
  console.log('4. Interrupted render recovery: PASS');

} catch (error) {
  console.error('TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  try {
    for (const item of created.reverse()) {
      await pool.query(
        `DELETE FROM haejumi_dev.creator_checkpoints
         WHERE task_id = $1`,
        [item.taskId]
      );

      await pool.query(
        `DELETE FROM haejumi_dev.creator_render_jobs
         WHERE job_id = $1`,
        [item.jobId]
      );

      await pool.query(
        `DELETE FROM haejumi_dev.creator_tasks
         WHERE task_id = $1`,
        [item.taskId]
      );

      await pool.query(
        `DELETE FROM haejumi_dev.creator_projects
         WHERE project_id = $1`,
        [item.projectId]
      );
    }

    console.log('5. Test cleanup: PASS');
  } catch (error) {
    console.error('CLEANUP FAILED:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}