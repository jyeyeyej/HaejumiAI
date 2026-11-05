
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresCreatorRepository } from './creator-repository.js';

const { Pool } = pg;
const DB = 'haejumi_dev';

const pool = new Pool({
  host: process.env.HAEJUMI_PG_HOST || '127.0.0.1',
  port: Number(process.env.HAEJUMI_PG_PORT || 5434),
  database: 'haejumi',
  user: 'haejumi_user',
  password: process.env.HAEJUMI_PG_PASSWORD,
  connectionTimeoutMillis: 5000
});

const repo = new PostgresCreatorRepository(pool);
const ownerId = `relations-test-${randomUUID()}`;
const fixtures = [];
const hash = 'test-content-hash';

async function count(table, column, value) {
  // These names come only from the fixed test definitions.
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM ${DB}.${table}
     WHERE ${column} = $1`,
    [value]
  );
  return result.rows[0].n;
}

async function createProject() {
  const projectId = randomUUID();
  const taskId = randomUUID();

  fixtures.push({ projectId, taskId });

  await repo.createProjectWithTask(
    {
      project_id: projectId,
      task_id: taskId,
      ownerId,
      status: 'test',
      current_version: 1,
      content_hash: hash
    },
    {
      task_id: taskId,
      project_id: projectId,
      ownerId,
      status: 'preview_approved',
      current_version: 1,
      content_hash: hash
    }
  );

  return { projectId, taskId };
}

async function addRelatedData(f) {
  const ids = {
    checkpoint: randomUUID(),
    approval: randomUUID(),
    job: randomUUID(),
    publication: randomUUID(),
    publicationApproval: randomUUID()
  };

  await pool.query(
    `INSERT INTO ${DB}.creator_checkpoints
     (checkpoint_id,task_id,owner_id,kind,status,
      content_version,content_hash,checkpoint_data)
     VALUES ($1,$2,$3,'preview','approved',1,$4,'{}'::jsonb)`,
    [ids.checkpoint, f.taskId, ownerId, hash]
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_approvals
     (approval_id,task_id,checkpoint_id,content_version,
      content_hash,approval_scope,status,approval_hash,
      approved_at,approval_data)
     VALUES ($1,$2,$3,1,$4,'continue','active',$5,NOW(),'{}'::jsonb)`,
    [ids.approval, f.taskId, ids.checkpoint, hash, 'test-approval-hash']
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_approval_idempotency
     (request_key,owner_id,fingerprint,approval_id)
     VALUES ($1,$2,'test-fingerprint',$3)`,
    [`checkpoint-${randomUUID()}`, ownerId, ids.approval]
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_render_jobs
     (job_id,task_id,owner_id,status,
      content_version,content_hash,job_data)
     VALUES ($1,$2,$3,'failed',1,$4,'{}'::jsonb)`,
    [ids.job, f.taskId, ownerId, hash]
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_render_idempotency
     (request_key,owner_id,fingerprint,job_id)
     VALUES ($1,$2,'test-fingerprint',$3)`,
    [`render-${randomUUID()}`, ownerId, ids.job]
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_publications
     (publication_id,task_id,owner_id,platform,revision,
      metadata_hash,status,publication_data)
     VALUES ($1,$2,$3,'youtube',1,$4,'draft','{}'::jsonb)`,
    [ids.publication, f.taskId, ownerId, 'test-metadata-hash']
  );

  await pool.query(
    `INSERT INTO ${DB}.creator_publication_approvals
     (approval_id,publication_id,task_id,owner_id,
      content_version,content_hash,artifact_sha256,
      publication_revision,publication_hash,approval_hash,
      status,approval_data)
     VALUES ($1,$2,$3,$4,1,$5,$6,1,$7,$8,
             'invalidated','{}'::jsonb)`,
    [
      ids.publicationApproval,
      ids.publication,
      f.taskId,
      ownerId,
      hash,
      'a'.repeat(64),
      'test-metadata-hash',
      'test-final-approval-hash'
    ]
  );

  for (const item of [
    ['publication', ids.publication],
    ['approval', ids.publicationApproval]
  ]) {
    await pool.query(
      `INSERT INTO ${DB}.creator_publication_idempotency
       (request_key,owner_id,fingerprint,resource_type,resource_id)
       VALUES ($1,$2,'test-fingerprint',$3,$4)`,
      [`pub-${randomUUID()}`, ownerId, item[0], item[1]]
    );
  }

  await pool.query(
    `INSERT INTO ${DB}.creator_idempotency
     (request_key,owner_id,fingerprint,project_id)
     VALUES ($1,$2,'test-fingerprint',$3)`,
    [`project-${randomUUID()}`, ownerId, f.projectId]
  );

  return ids;
}

async function run() {
  const target = await createProject();
  const other = await createProject();
  const ids = await addRelatedData(target);

  const records = [
    ['creator_projects', 'project_id', target.projectId, 1],
    ['creator_tasks', 'task_id', target.taskId, 1],
    ['creator_checkpoints', 'checkpoint_id', ids.checkpoint, 1],
    ['creator_approvals', 'approval_id', ids.approval, 1],
    ['creator_approval_idempotency', 'approval_id', ids.approval, 1],
    ['creator_render_jobs', 'job_id', ids.job, 1],
    ['creator_render_idempotency', 'job_id', ids.job, 1],
    ['creator_publications', 'publication_id', ids.publication, 1],
    ['creator_publication_approvals', 'approval_id', ids.publicationApproval, 1],
    ['creator_publication_idempotency', 'owner_id', ownerId, 2],
    ['creator_idempotency', 'project_id', target.projectId, 1]
  ];

  for (const [table, column, value, expected] of records) {
    assert.equal(
      await count(table, column, value),
      expected,
      `Fixture missing: ${table}`
    );
  }
  console.log('1. All 11 table fixtures verified: PASS');

  const deleted = await repo.deleteProject(
    target.projectId,
    ownerId
  );

  assert.equal(deleted.deleted, true);
  console.log('2. Project deletion: PASS');

  for (const [table, column, value] of records) {
    assert.equal(
      await count(table, column, value),
      0,
      `Orphan records in ${table}`
    );
  }
  console.log('3. Related records removed from all 11 tables: PASS');

  assert.equal(
    await count('creator_projects', 'project_id', other.projectId),
    1
  );
  assert.equal(
    await count('creator_tasks', 'task_id', other.taskId),
    1
  );

  console.log('4. Unrelated project preserved: PASS');
  console.log('\n4/4 PASS');
}

async function cleanup() {
  for (const f of fixtures) {
    const exists = await count(
      'creator_projects',
      'project_id',
      f.projectId
    );

    if (exists === 0) continue;

    const result = await repo.deleteProject(f.projectId, ownerId);

    if (!result.deleted) {
      throw new Error(`Cleanup blocked: ${result.reason}`);
    }
  }

  for (const f of fixtures) {
    assert.equal(
      await count('creator_projects', 'project_id', f.projectId),
      0
    );
  }

  console.log('Test cleanup: PASS');
}

let failed = false;

try {
  await run();
} catch (error) {
  failed = true;
  console.error('TEST FAILED:', error);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failed = true;
    console.error('CLEANUP FAILED:', error);
  }
  await pool.end();
}

if (failed) process.exitCode = 1;
