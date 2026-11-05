
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createPostgresPool } from '../src/adapters/postgres/connection.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const baselinePath = path.join(
  currentDir,
  'schema-baseline',
  'haejumi_dev_baseline.sql'
);

const expectedTables = [
  'creator_approval_idempotency',
  'creator_approvals',
  'creator_checkpoints',
  'creator_idempotency',
  'creator_projects',
  'creator_publication_approvals',
  'creator_publication_idempotency',
  'creator_publications',
  'creator_render_idempotency',
  'creator_render_jobs',
  'creator_tasks'
];

async function getBaselineChecksum() {
  const content = await readFile(baselinePath);

  return createHash('sha256')
    .update(content)
    .digest('hex');
}

async function verifyExistingSchema(client) {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'haejumi_dev'
      AND table_type = 'BASE TABLE'
      AND table_name <> 'schema_migrations'
    ORDER BY table_name
  `);

  const actual = result.rows.map(row => row.table_name);

  if (JSON.stringify(actual) !== JSON.stringify(expectedTables)) {
    throw new Error(
      'SCHEMA_MISMATCH: Existing Creator tables do not match.'
    );
  }

  console.log('Existing Creator tables: 11/11 verified');
}

async function verifyMigrationTable(client) {
  const result = await client.query(`
    SELECT
      to_regclass('haejumi_dev.schema_migrations') AS table_name
  `);

  if (!result.rows[0].table_name) {
    throw new Error(
      'MIGRATION_TABLE_MISSING: Run schema-migrations.sql first.'
    );
  }
}

async function showStatus(client) {
  const result = await client.query(`
    SELECT version, description, checksum, applied_at
    FROM haejumi_dev.schema_migrations
    ORDER BY applied_at, version
  `);

  console.log('\n=== Migration Status ===');

  if (result.rows.length === 0) {
    console.log('No migrations registered.');
    return;
  }

  console.table(result.rows);
}

async function registerBaseline(client) {
  await client.query('BEGIN');

  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(20261105, 1)'
    );

    await verifyExistingSchema(client);

    const checksum = await getBaselineChecksum();

    const existing = await client.query(`
      SELECT checksum
      FROM haejumi_dev.schema_migrations
      WHERE version = 'baseline'
    `);

    if (existing.rows.length > 0) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(
          'BASELINE_CHECKSUM_MISMATCH: Baseline file changed.'
        );
      }

      console.log('Baseline already registered. No changes.');
      await client.query('COMMIT');
      return;
    }

    const history = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM haejumi_dev.schema_migrations
    `);

    if (history.rows[0].count !== 0) {
      throw new Error(
        'MIGRATION_HISTORY_NOT_EMPTY: Manual review required.'
      );
    }

    await client.query(`
      INSERT INTO haejumi_dev.schema_migrations
        (version, description, checksum)
      VALUES ($1, $2, $3)
    `, [
      'baseline',
      'Existing 11 Creator tables',
      checksum
    ]);

    await client.query('COMMIT');

    console.log('BASELINE REGISTERED: PASS');
    console.log(`Checksum: ${checksum}`);

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const command = process.argv[2] ?? '--status';

  if (!['--status', '--baseline'].includes(command)) {
    throw new Error('Usage: node migrate.mjs --status|--baseline');
  }

  if (!process.env.HAEJUMI_PG_PASSWORD) {
    throw new Error('HAEJUMI_PG_PASSWORD is required.');
  }

  const database = process.env.HAEJUMI_PG_DATABASE;

if (!['haejumi', 'haejumi_migration_test'].includes(database)) {
  throw new Error('DATABASE_NOT_ALLOWED: Explicit DB selection required');
}

console.log(`Target database: ${database}`);

const pool = createPostgresPool({ database });

  try {
    const client = await pool.connect();

    try {
      await verifyMigrationTable(client);

      if (command === '--status') {
        await showStatus(client);
      }

      if (command === '--baseline') {
        await registerBaseline(client);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('MIGRATION FAILED:', error.message);
  process.exitCode = 1;
});
