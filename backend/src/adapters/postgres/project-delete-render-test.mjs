
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresCreatorRepository } from './creator-repository.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.HAEJUMI_PG_HOST || '127.0.0.1',
  port: Number(process.env.HAEJUMI_PG_PORT || 5434),
  database: 'haejumi',
  user: 'haejumi_user',
  password: process.env.HAEJUMI_PG_PASSWORD,
  connectionTimeoutMillis: 5000
});

const repo = new PostgresCreatorRepository(pool);
const ownerId = `render-delete-test-${randomUUID()}`;
const fixtures = [];

async function createFixture(status) {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const jobId = randomUUID();

  // Record identifiers before database writes for cleanup.
  fixtures.push({ projectId, taskId, jobId });

  const project = {
    project_id: projectId,
    task_id: taskId,
    ownerId,
    status: 'waiting_plan_approval',
    current_version: 1
  };

  const task = {
    task_id: taskId,
    project_id: projectId,
    ownerId,
    status: 'waiting_plan_approval',
    current_version: 1
  };

  await repo.createProjectWithTask(project, task);

  await pool.query(
    `INSERT INTO haejumi_dev.creator_render_jobs
     (job_id, task_id, owner_id, status,
      content_version, content_hash, job_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      jobId,
      taskId,
      ownerId,
      status,
      1,
      'test-content-hash',
      JSON.stringify({ job_id: jobId, status })

    ]
  );

  return { projectId, taskId, jobId };
}

async function projectExists(projectId) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM haejumi_dev.creator_projects
       WHERE project_id = $1
     ) AS exists`,
    [projectId]
  );

  return result.rows[0].exists;
}

async function jobExists(jobId) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM haejumi_dev.creator_render_jobs
       WHERE job_id = $1
     ) AS exists`,
    [jobId]
  );

  return result.rows[0].exists;
}

async function assertBlocked(status) {
  const fixture = await createFixture(status);

  const result = await repo.deleteProject(
    fixture.projectId,
    ownerId
  );

  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'ACTIVE_RENDER');

  assert.equal(await projectExists(fixture.projectId), true);
  assert.equal(await jobExists(fixture.jobId), true);

  console.log(`${status} render deletion blocked: PASS`);
}

async function assertTerminal(status) {
  const fixture = await createFixture(status);

  const result = await repo.deleteProject(
    fixture.projectId,
    ownerId
  );

  assert.equal(result.deleted, true);
  assert.equal(await projectExists(fixture.projectId), false);
  assert.equal(await jobExists(fixture.jobId), false);

  console.log(`${status} render deletion allowed: PASS`);
}

async function cleanup() {
  for (const fixture of fixtures) {
    const exists = await projectExists(fixture.projectId);

    if (!exists) continue;

    // Only test-generated jobs are changed.
    await pool.query(
      `UPDATE haejumi_dev.creator_render_jobs
       SET status = 'failed'
       WHERE job_id = $1 AND owner_id = $2`,
      [fixture.jobId, ownerId]
    );

    const result = await repo.deleteProject(
      fixture.projectId,
      ownerId
    );

    if (!result.deleted && result.reason !== 'NOT_FOUND') {
      throw new Error(`Cleanup blocked: ${result.reason}`);
    }
  }

  console.log('Test cleanup: PASS');
}

let failed = false;

try {
  
await assertBlocked('queued');
await assertBlocked('running');
await assertTerminal('succeeded');
await assertTerminal('failed');
await assertTerminal('cancelled');


  console.log('\n5/5 PASS');
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
