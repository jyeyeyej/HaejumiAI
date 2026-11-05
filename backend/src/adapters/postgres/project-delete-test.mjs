
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresCreatorRepository } from './creator-repository.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.HAEJUMI_PG_HOST || '127.0.0.1',
  port: Number(process.env.HAEJUMI_PG_PORT || 5432),
  database: 'haejumi',
  user: 'haejumi_user',
  password: process.env.HAEJUMI_PG_PASSWORD,
  connectionTimeoutMillis: 5000
});

const repo = new PostgresCreatorRepository(pool);
const ownerId = `delete-test-${randomUUID()}`;
const otherOwner = `other-${randomUUID()}`;
const testProjects = [];

async function createFixture() {
  const projectId = randomUUID();
  const taskId = randomUUID();

  const project = {
    project_id: projectId,
    task_id: taskId,
    ownerId,
    status: 'waiting_plan_approval',
    current_version: 1,
    content_hash: null
  };

  const task = {
    task_id: taskId,
    project_id: projectId,
    ownerId,
    status: 'waiting_plan_approval',
    current_version: 1,
    content_hash: null
  };

  await repo.createProjectWithTask(project, task);
  testProjects.push(projectId);

  return { projectId, taskId };
}

async function countProject(projectId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM haejumi_dev.creator_projects
     WHERE project_id = $1`,
    [projectId]
  );

  return result.rows[0].count;
}

async function run() {
  const first = await createFixture();
  const second = await createFixture();

  const denied = await repo.deleteProject(
    first.projectId,
    otherOwner
  );

  assert.equal(denied.deleted, false);
  assert.equal(await countProject(first.projectId), 1);
  console.log('1. Other owner rejection: PASS');

  const missing = await repo.deleteProject(
    randomUUID(),
    ownerId
  );

  assert.equal(missing.deleted, false);
  assert.equal(missing.reason, 'NOT_FOUND');
  console.log('2. Missing project: PASS');

  const deleted = await repo.deleteProject(
    first.projectId,
    ownerId
  );

  assert.equal(deleted.deleted, true);
  assert.equal(await countProject(first.projectId), 0);

  const taskResult = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM haejumi_dev.creator_tasks
     WHERE task_id = $1`,
    [first.taskId]
  );

  assert.equal(taskResult.rows[0].count, 0);
  console.log('3. Project and task deletion: PASS');

  assert.equal(await countProject(second.projectId), 1);
  console.log('4. Other project preserved: PASS');

  console.log('\n4/4 PASS');
}

async function cleanup() {
  // Only test-owned UUIDs are eligible for cleanup.
  for (const projectId of testProjects) {
    const result = await repo.deleteProject(projectId, ownerId);

    if (!result.deleted && result.reason !== 'NOT_FOUND') {
      throw new Error(`Cleanup blocked: ${result.reason}`);
    }
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

if (failed) {
  process.exitCode = 1;
}
