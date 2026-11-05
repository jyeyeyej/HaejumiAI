import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './connection.js';
import {
  createCreatorPublication,
  listCreatorPublications,
  getCreatorPublication,
  updateCreatorPublication
} from './creator-publication.js';

const pool = createPostgresPool();
const projectId = randomUUID();
const taskId = randomUUID();
const ownerId = `publication-test-${randomUUID()}`;

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

try {
  // Synthetic project and task: no real user data.
  await pool.query(
    `INSERT INTO haejumi_dev.creator_projects
     (project_id, owner_id, task_id, status,
      current_version, content_hash, project_data)
     VALUES ($1, $2, $3, 'test', 1, $4, '{}'::jsonb)`,
    [projectId, ownerId, taskId, 'test-content-hash']
  );

  await pool.query(
    `INSERT INTO haejumi_dev.creator_tasks
     (task_id, project_id, owner_id, status,
      current_version, content_hash, task_data)
     VALUES ($1, $2, $3, 'test', 1, $4, '{}'::jsonb)`,
    [taskId, projectId, ownerId, 'test-content-hash']
  );

  const input = {
    platform: 'youtube',
    account_id: 'test-account',
    visibility: 'private',
    title: '테스트 쇼츠',
    description: '테스트 설명',
    hashtags: ['#테스트']
  };

  const created = await createCreatorPublication(
    pool, ownerId, taskId, input, 'create-001'
  );

  check(
    created.platform === 'youtube' && created.revision === 1,
    'Publication creation'
  );

  const listed = await listCreatorPublications(
    pool, ownerId, taskId
  );

  const fetched = await getCreatorPublication(
    pool, ownerId, taskId, created.publication_id
  );

  check(
    listed.length === 1 &&
    fetched.publication_id === created.publication_id,
    'Publication list and get'
  );

  const modified = await updateCreatorPublication(
    pool, ownerId, taskId, created.publication_id,
    { ...input, title: '수정한 쇼츠', revision: 1 },
    'update-001'
  );

  check(
    modified.title === '수정한 쇼츠' &&
    modified.revision === 2 &&
    modified.status === 'draft',
    'Publication update and revision'
  );

  await expectError(
    () => createCreatorPublication(
      pool, ownerId, taskId, input, 'create-002'
    ),
    'PUBLICATION_ALREADY_EXISTS'
  );

  check(true, 'Duplicate platform prevention');

  const repeated = await createCreatorPublication(
    pool, ownerId, taskId, input, 'create-001'
  );

  check(
    repeated.publication_id === created.publication_id,
    'Idempotent creation'
  );

  const repeatedUpdate = await updateCreatorPublication(
    pool, ownerId, taskId, created.publication_id,
    { ...input, title: '수정한 쇼츠', revision: 1 },
    'update-001'
  );

  check(
    repeatedUpdate.revision === 2,
    'Idempotent update'
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