
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createPostgresPool } from '../src/adapters/postgres/connection.js';

const baseDir = path.dirname(fileURLToPath(import.meta.url));


const targetDatabase = process.env.HAEJUMI_PG_DATABASE;

const migrationsDir = path.join(
  baseDir,
  targetDatabase === 'haejumi_migration_test'
    ? 'migrations-test'
    : 'migrations'
);


function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function getMigrations() {
  const names = (await readdir(migrationsDir))
    .filter(name => name.endsWith('.sql'))
    .sort();

  for (const name of names) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`INVALID_MIGRATION_NAME: ${name}`);
    }
  }

  const versions = names.map(name => name.slice(0, 3));

  if (new Set(versions).size !== versions.length) {
    throw new Error('DUPLICATE_MIGRATION_VERSION');
  }

  const migrations = [];

  for (const name of names) {
    const content = await readFile(
      path.join(migrationsDir, name)
    );

    if (!content.toString('utf8').trim()) {
      throw new Error(`EMPTY_MIGRATION: ${name}`);
    }

    migrations.push({
      version: name.slice(0, 3),
      description: name,
      sql: content.toString('utf8'),
      checksum: checksum(content)
    });
  }

  return migrations;
}

async function applyMigrations() {
  if (!process.env.HAEJUMI_PG_PASSWORD) {
    throw new Error('HAEJUMI_PG_PASSWORD is required');
  }

  const migrations = await getMigrations();
  const database = process.env.HAEJUMI_PG_DATABASE;

if (!['haejumi', 'haejumi_migration_test'].includes(database)) {
  throw new Error('DATABASE_NOT_ALLOWED: Explicit DB selection required');
}

console.log(`Target database: ${database}`);

const pool = createPostgresPool({ database });
  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    // 다른 마이그레이션 실행과 충돌하지 않도록 잠금
    await client.query(
      'SELECT pg_advisory_xact_lock(20261105, 1)'
    );

    const history = await client.query(`
      SELECT version, checksum
      FROM haejumi_dev.schema_migrations
    `);

    const applied = new Map(
      history.rows.map(row => [row.version, row.checksum])
    );

    if (!applied.has('baseline')) {
      throw new Error('BASELINE_NOT_REGISTERED');
    }

    const baselineContent = await readFile(
      path.join(
        baseDir,
        'schema-baseline',
        'haejumi_dev_baseline.sql'
      )
    );

    const baselineChecksum = checksum(baselineContent);

    if (applied.get('baseline') !== baselineChecksum) {
      throw new Error('BASELINE_CHECKSUM_MISMATCH');
    }

    const knownVersions = new Set([
      'baseline',
      ...migrations.map(item => item.version)
    ]);

    for (const version of applied.keys()) {
      if (!knownVersions.has(version)) {
        throw new Error(
          `UNKNOWN_APPLIED_MIGRATION: ${version}`
        );
      }
    }

    const pending = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== migration.checksum) {
          throw new Error(
            `MIGRATION_CHECKSUM_MISMATCH: ${migration.description}`
          );
        }

        console.log(`[SKIP] ${migration.description}`);
      } else {
        pending.push(migration);
      }
    }

    const appliedNumbers = [...applied.keys()]
      .filter(version => version !== 'baseline')
      .map(Number);

    const highestApplied = appliedNumbers.length
      ? Math.max(...appliedNumbers)
      : -1;

    if (pending.some(item => Number(item.version) < highestApplied)) {
      throw new Error('OUT_OF_ORDER_MIGRATION');
    }

    for (const migration of pending) {
      console.log(`[APPLY] ${migration.description}`);

      await client.query(migration.sql);

      await client.query(
        `INSERT INTO haejumi_dev.schema_migrations
         (version, description, checksum)
         VALUES ($1, $2, $3)`,
        [
          migration.version,
          migration.description,
          migration.checksum
        ]
      );
    }

    await client.query('COMMIT');

    console.log(
      `MIGRATIONS PASS: ${pending.length} newly applied`
    );
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('ROLLBACK FAILED:', rollbackError.message);
      }
    }

    throw error;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

applyMigrations().catch(error => {
  console.error('MIGRATION FAILED:', error.message);
  process.exitCode = 1;
});
