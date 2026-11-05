import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import { claimCreatorRenderJob } from './creator-render.js';

const pool = createPostgresPool();

const ownerId = 'render-claim-test-' + randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const jobId = randomUUID();

try {
  await pool.query(
    `INSERT INTO haejumi_dev.creator_projects
     (project_id, owner_id, task_id, status, current_version)
     VALUES ($1, $2, $3, 'rendering', 1)`,
    [projectId, ownerId, taskId]
  );

  
await pool.query(
  `INSERT INTO haejumi_dev.creator_tasks
   (task_id, project_id, owner_id, status,
    current_version, content_hash, task_data)
   VALUES ($1, $2, $3, 'rendering',
           1, $4, $5::jsonb)`,
  [
    taskId,
    projectId,
    ownerId,
    'test-hash',
    JSON.stringify({
      active_job_id: jobId
    })
  ]
);


  await pool.query(
    `INSERT INTO haejumi_dev.creator_render_jobs
     (job_id, task_id, owner_id, status, content_version, content_hash)
     VALUES ($1, $2, $3, 'queued', 1, 'test-hash')`,
    [jobId, taskId, ownerId]
  );

  const first = await claimCreatorRenderJob(pool, jobId);

  assert.equal(first.status, 'running');
  console.log('1. Queued to running: PASS');

  const second = await claimCreatorRenderJob(pool, jobId);

  assert.equal(second, null);
  console.log('2. Duplicate claim blocked: PASS');

  const saved = await pool.query(
    `SELECT status, job_data
     FROM haejumi_dev.creator_render_jobs
     WHERE job_id = $1`,
    [jobId]
  );

  assert.equal(saved.rows[0].status, 'running');
  assert.equal(saved.rows[0].job_data.status, 'running');
  console.log('3. Database state verified: PASS');

} catch (error) {
  console.error('TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  try {
    await pool.query(
      'DELETE FROM haejumi_dev.creator_render_jobs WHERE job_id = $1',
      [jobId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_tasks WHERE task_id = $1',
      [taskId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_projects WHERE project_id = $1',
      [projectId]
    );
    console.log('4. Test cleanup: PASS');
  } catch (error) {
    console.error('CLEANUP FAILED:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}