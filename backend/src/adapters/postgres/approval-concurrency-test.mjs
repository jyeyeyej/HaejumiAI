import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import { approveCreatorCheckpoint } from './creator-checkpoint-approval.js';

const pool = createPostgresPool();
const ownerId = 'approval-concurrency-test-' + randomUUID();
const hash = 'test-content-hash';
const sharedKey = 'same-approval-key';
const tasks = [];

async function createTestTask() {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const checkpointId = randomUUID();
  tasks.push({ projectId, taskId });

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

  return {
    ownerId,
    taskId,
    checkpointId,
    contentVersion: 1,
    contentHash: hash,
    idempotencyKey: sharedKey
  };
}

try {
  const requestA = await createTestTask();
  const requestB = await createTestTask();

  const results = await Promise.allSettled([
    approveCreatorCheckpoint(pool, requestA),
    approveCreatorCheckpoint(pool, requestB)
  ]);

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      console.log(`Request ${index + 1}: SUCCESS`);
    } else {
      console.log(`Request ${index + 1}: FAILED (${result.reason.code ?? result.reason.message})`);
    }
  }

  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);

  const approvalCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM haejumi_dev.creator_approvals
     WHERE task_id = ANY($1::uuid[])`,
    [tasks.map(t => t.taskId)]
  );

  assert.equal(approvalCount.rows[0].total, 1);
  console.log('Exactly one approval: PASS');

  const failedCode = failures[0].reason.code ?? failures[0].reason.message;

  if (failedCode === 'IDEMPOTENCY_CONFLICT') {
    console.log('Conflict handling: PASS');
  } else {
    console.log('Conflict handling: NEEDS FIX (' + failedCode + ')');
    process.exitCode = 1;
  }

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
      `DELETE FROM haejumi_dev.creator_approvals
       WHERE task_id = ANY($1::uuid[])`,
      [tasks.map(t => t.taskId)]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_checkpoints WHERE owner_id = $1',
      [ownerId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_tasks WHERE owner_id = $1',
      [ownerId]
    );
    await pool.query(
      'DELETE FROM haejumi_dev.creator_projects WHERE owner_id = $1',
      [ownerId]
    );
    console.log('Test cleanup: PASS');
  } catch (error) {
    console.error('CLEANUP FAILED:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}