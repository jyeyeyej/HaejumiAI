import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import { createCreatorPublication } from './creator-publication.js';
import {
  approveCreatorPublication,
  invalidateCreatorPublicationApprovals
} from './creator-publication-approval.js';

const pool = createPostgresPool();

const ownerId = `publication-approval-test-${randomUUID()}`;
const projectId = randomUUID();
const taskId = randomUUID();
const checkpointId = randomUUID();
const previewApprovalId = randomUUID();
const renderJobId = randomUUID();

const contentHash = 'test-content-hash';
const artifactHash = 'a'.repeat(64);

let passed = 0;

function check(condition, label) {
  if (!condition) throw new Error(label);
  passed++;
  console.log(`${passed}. ${label}: PASS`);
}

async function expectError(action, code) {
  try {
    await action();
  } catch (error) {
    if (error.message === code || error.code === code) return;
    throw error;
  }
  throw new Error(`Expected error: ${code}`);
}

async function cleanup() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM haejumi_dev.creator_publication_idempotency
       WHERE owner_id = $1`,
      [ownerId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_publication_approvals
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_publications
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_approval_idempotency
       WHERE approval_id = $1`,
      [previewApprovalId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_approvals
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_checkpoints
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_render_idempotency
       WHERE job_id = $1`,
      [renderJobId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_render_jobs
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_tasks
       WHERE task_id = $1`,
      [taskId]
    );

    await client.query(
      `DELETE FROM haejumi_dev.creator_projects
       WHERE project_id = $1`,
      [projectId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setup() {
  await pool.query(
    `INSERT INTO haejumi_dev.creator_projects
     (project_id, owner_id, task_id, status,
      current_version, content_hash, project_data)
     VALUES ($1, $2, $3, 'test', 1, $4, '{}'::jsonb)`,
    [projectId, ownerId, taskId, contentHash]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_tasks
     (task_id, project_id, owner_id, status,
      current_version, content_hash, task_data)
     VALUES ($1, $2, $3, 'preview_approved',
             1, $4, '{}'::jsonb)`,
    [taskId, projectId, ownerId, contentHash]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_checkpoints
     (checkpoint_id, task_id, owner_id, kind,
      status, content_version, content_hash, checkpoint_data)
     VALUES ($1, $2, $3, 'preview',
             'approved', 1, $4, '{}'::jsonb)`,
    [checkpointId, taskId, ownerId, contentHash]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_approvals
     (approval_id, task_id, checkpoint_id,
      content_version, content_hash, approval_scope,
      status, approval_hash, approved_at, approval_data)
     VALUES ($1,$2,$3,1,$4,'continue',
             'active',$5,NOW(),'{}'::jsonb)`,
    [
      previewApprovalId,
      taskId,
      checkpointId,
      contentHash,
      'test-approval-hash'
    ]
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_render_jobs
     (job_id, task_id, owner_id, status,
      content_version, content_hash, job_data)
     VALUES ($1,$2,$3,'succeeded',1,$4,$5::jsonb)`,
    [
      renderJobId,
      taskId,
      ownerId,
      contentHash,
      JSON.stringify({
        renderer_mode: 'ffmpeg',
        artifact_verified: true,
        artifact_sha256: artifactHash,
        completed_at: new Date().toISOString()
      })
    ]
  );
}

try {
  await setup();

  const publicationInput = {
    platform: 'youtube',
    account_id: 'test-account',
    visibility: 'private',
    title: '테스트 쇼츠',
    description: '테스트 설명',
    hashtags: ['#테스트']
  };

  const publication = await createCreatorPublication(
    pool, ownerId, taskId, publicationInput, 'create-001'
  );

  const approvalInput = {
    content_version: 1,
    content_hash: contentHash,
    artifact_sha256: artifactHash,
    publication_revision: publication.revision,
    publication_hash: publication.metadata_hash
  };

  const args = {
    ownerId,
    taskId,
    publicationId: publication.publication_id,
    input: approvalInput,
    idempotencyKey: 'approve-001',
    verifyRights: async () => true
  };

  // 1. Final approval with a simulated rights verifier.
  const approved = await approveCreatorPublication(pool, args);

  check(
    approved.status === 'active' &&
    approved.artifact_sha256 === artifactHash,
    'Final publication approval'
  );

  // 2. Idempotent final approval.
  const repeated = await approveCreatorPublication(pool, args);

  check(
    repeated.approval_id === approved.approval_id,
    'Idempotent final approval'
  );

  // 3. Rights verification failure.
  await expectError(
    () => approveCreatorPublication(pool, {
      ...args,
      idempotencyKey: 'approve-rights-denied',
      verifyRights: async () => false
    }),
    'RIGHTS_REVIEW_REQUIRED'
  );

  check(true, 'Rights verification failure');

  // 4. Reject simulated render.
  await pool.query(
    `UPDATE haejumi_dev.creator_render_jobs
     SET job_data = job_data ||
         '{"renderer_mode":"test"}'::jsonb
     WHERE job_id = $1`,
    [renderJobId]
  );

  await expectError(
    () => approveCreatorPublication(pool, {
      ...args,
      idempotencyKey: 'approve-simulated'
    }),
    'RENDER_REQUIRED'
  );

  check(true, 'Simulated render rejection');

  // Restore verified render.
  await pool.query(
    `UPDATE haejumi_dev.creator_render_jobs
     SET job_data = job_data ||
         '{"renderer_mode":"ffmpeg"}'::jsonb
     WHERE job_id = $1`,
    [renderJobId]
  );

  // 5. Reject unapproved preview.
  await pool.query(
    `UPDATE haejumi_dev.creator_checkpoints
     SET status = 'pending'
     WHERE checkpoint_id = $1`,
    [checkpointId]
  );

  await expectError(
    () => approveCreatorPublication(pool, {
      ...args,
      idempotencyKey: 'approve-no-preview'
    }),
    'RENDER_REQUIRED'
  );

  check(true, 'Unapproved preview rejection');

  // Restore preview approval.
  await pool.query(
    `UPDATE haejumi_dev.creator_checkpoints
     SET status = 'approved'
     WHERE checkpoint_id = $1`,
    [checkpointId]
  );

  // 6. Content version change invalidates final approval.
  await pool.query(
    `UPDATE haejumi_dev.creator_tasks
     SET current_version = 2,
         content_hash = 'changed-content-hash'
     WHERE task_id = $1`,
    [taskId]
  );

  const invalidated = await invalidateCreatorPublicationApprovals(
    pool, ownerId, taskId
  );

  const approvalStatus = await pool.query(
    `SELECT status
     FROM haejumi_dev.creator_publication_approvals
     WHERE approval_id = $1`,
    [approved.approval_id]
  );

  check(
    invalidated === 1 &&
    approvalStatus.rows[0].status === 'invalidated',
    'Content change invalidates approval'
  );

  console.log(`\n${passed}/6 PASS`);
} catch (error) {
  console.error('TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
    console.log('Test cleanup: PASS');
  } catch (error) {
    console.error('Test cleanup: FAILED', error);
    process.exitCode = 1;
  }

  await pool.end();
}
