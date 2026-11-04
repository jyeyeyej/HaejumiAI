import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import { approveCreatorCheckpoint } from './creator-checkpoint-approval.js';

const pool = createPostgresPool();
const ownerId = 'approval-idempotency-test-' + randomUUID();
const projectId = randomUUID();
const taskId = randomUUID();
const checkpointId = randomUUID();
const hash = 'test-content-hash';

try {
  await pool.query(
    `INSERT INTO haejumi_dev.creator_projects
     (project_id, owner_id, task_id, status, current_version)
     VALUES ($1,$2,$3,'created',1)`,
    [projectId, ownerId, taskId]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_tasks
     (task_id, project_id, owner_id, status, current_version, content_hash)
     VALUES ($1,$2,$3,'waiting_plan_approval',1,$4)`,
    [taskId, projectId, ownerId, hash]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_checkpoints
     (checkpoint_id, task_id, owner_id, kind, status, content_version, content_hash)
     VALUES ($1,$2,$3,'plan','pending',1,$4)`,
    [checkpointId, taskId, ownerId, hash]
  );

  const request = {
    ownerId,
    taskId,
    checkpointId,
    contentVersion: 1,
    contentHash: hash,
    idempotencyKey: 'test-approval-key'
  };

  const first = await approveCreatorCheckpoint(pool, request);
  assert.equal(first.status, 'active');
  console.log('1. New approval: PASS');

  const repeated = await approveCreatorCheckpoint(pool, request);
  assert.equal(repeated.approval_id, first.approval_id);
  console.log('2. Same key and same content: PASS');

  await assert.rejects(
    approveCreatorCheckpoint(pool, {
      ...request,
      contentHash: 'different-hash'
    }),
    /IDEMPOTENCY_CONFLICT/
  );
  console.log('3. Same key and different content: PASS');

  const count = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM haejumi_dev.creator_approvals
     WHERE task_id = $1`,
    [taskId]
  );

  assert.equal(count.rows[0].total, 1);
  console.log('4. Exactly one approval: PASS');

} catch (error) {
  console.error('TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  try {
    await pool.query(
      'DELETE FROM haejumi_dev.creator_approval_idempotency WHERE owner_id = $1',
      [ownerId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_approvals WHERE task_id = $1',
      [taskId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_checkpoints WHERE task_id = $1',
      [taskId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_tasks WHERE task_id = $1',
      [taskId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_projects WHERE project_id = $1',
      [projectId]
    );
    console.log('5. Test cleanup: PASS');
  } finally {
    await pool.end();
  }
}