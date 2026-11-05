
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

const projectId = randomUUID();
const taskId = randomUUID();
const ownerId = `rollback-test-${randomUUID()}`;

let created = false;
let failed = false;

async function getCounts() {
  const project = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM haejumi_dev.creator_projects
     WHERE project_id = $1 AND owner_id = $2`,
    [projectId, ownerId]
  );

  const task = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM haejumi_dev.creator_tasks
     WHERE task_id = $1 AND project_id = $2`,
    [taskId, projectId]
  );

  return {
    projects: project.rows[0].n,
    tasks: task.rows[0].n
  };
}

async function testRollback() {
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
  created = true;

  assert.deepEqual(await getCounts(), {
    projects: 1,
    tasks: 1
  });

  console.log('1. Test fixture created: PASS');

  let injected = false;

  // Wrap only the database client used by this test.
  // Real PostgreSQL transactions still execute normally.
  const faultPool = {
    async connect() {
      const client = await pool.connect();

      return {
        query: async (...args) => {
          const sql = String(args[0]);

          if (
            !injected &&
            /^\s*DELETE\s+FROM\s+haejumi_dev\.creator_projects\b/i.test(sql)
          ) {
            injected = true;
            throw new Error('TEST_INJECTED_DELETE_FAILURE');
          }

          return client.query(...args);
        },
        release: () => client.release()
      };
    }
  };

  const faultRepo = new PostgresCreatorRepository(faultPool);

  await assert.rejects(
    () => faultRepo.deleteProject(projectId, ownerId),
    /TEST_INJECTED_DELETE_FAILURE/
  );

  assert.equal(injected, true);
  console.log('2. Simulated deletion error: PASS');

  assert.deepEqual(await getCounts(), {
    projects: 1,
    tasks: 1
  });

  console.log('3. Transaction rollback preserved data: PASS');

  const result = await repo.deleteProject(projectId, ownerId);

  assert.equal(result.deleted, true);
  assert.deepEqual(await getCounts(), {
    projects: 0,
    tasks: 0
  });

  console.log('4. Normal deletion after rollback: PASS');
  console.log('\n4/4 PASS');
}

async function cleanup() {
  if (!created) {
    console.log('Test cleanup: NOT NEEDED');
    return;
  }

  const counts = await getCounts();

  if (counts.projects === 0 && counts.tasks === 0) {
    console.log('Test cleanup: PASS');
    return;
  }

  const result = await repo.deleteProject(projectId, ownerId);

  if (!result.deleted && result.reason !== 'NOT_FOUND') {
    throw new Error(`Cleanup blocked: ${result.reason}`);
  }

  assert.deepEqual(await getCounts(), {
    projects: 0,
    tasks: 0
  });

  console.log('Test cleanup: PASS');
}

try {
  await testRollback();
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
