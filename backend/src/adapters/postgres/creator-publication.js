import { randomUUID, createHash } from 'node:crypto';

const TABLE = 'haejumi_dev.creator_publications';
const IDEMPOTENCY = 'haejumi_dev.creator_publication_idempotency';
const PLATFORMS = ['youtube', 'instagram', 'tiktok'];

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('VALIDATION_ERROR');
  }

  const {
    platform, account_id, visibility,
    title, description, hashtags
  } = input;

  if (
    !PLATFORMS.includes(platform) ||
    typeof account_id !== 'string' || !account_id.trim() ||
    typeof visibility !== 'string' || !visibility.trim() ||
    typeof title !== 'string' || !title.trim() ||
    typeof description !== 'string' ||
    !Array.isArray(hashtags) ||
    hashtags.some(tag => typeof tag !== 'string')
  ) {
    throw new Error('VALIDATION_ERROR');
  }

  return {
    platform,
    account_id,
    visibility,
    title,
    description,
    hashtags
  };
}

async function transaction(pool, action) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function requireTask(client, ownerId, taskId) {
  const result = await client.query(
    `SELECT task_id FROM haejumi_dev.creator_tasks
     WHERE task_id = $1 AND owner_id = $2
     FOR UPDATE`,
    [taskId, ownerId]
  );

  if (result.rowCount !== 1) {
    throw new Error('RESOURCE_NOT_FOUND');
  }
}

function publicValue(row) {
  return {
    publication_id: row.publication_id,
    task_id: row.task_id,
    owner_id: row.owner_id,
    ...row.publication_data,
    revision: row.revision,
    metadata_hash: row.metadata_hash,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function requireKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('VALIDATION_ERROR');
  }
}

async function findPrevious(client, key, fingerprint) {
  const result = await client.query(
    `SELECT fingerprint, resource_id
     FROM ${IDEMPOTENCY}
     WHERE request_key = $1`,
    [key]
  );

  if (!result.rowCount) return null;

  if (result.rows[0].fingerprint !== fingerprint) {
    throw new Error('IDEMPOTENCY_CONFLICT');
  }

  return result.rows[0].resource_id;
}

// 1. Create publication
export async function createCreatorPublication(
  pool, ownerId, taskId, input, idempotencyKey
) {
  const value = validateInput(input);
  requireKey(idempotencyKey);

  const fingerprint = JSON.stringify({ task_id: taskId, ...value });
  const key = `${ownerId}:publication-create:${idempotencyKey}`;

  return transaction(pool, async client => {
    await requireTask(client, ownerId, taskId);

    const previousId = await findPrevious(client, key, fingerprint);

    if (previousId) {
      const prior = await client.query(
        `SELECT * FROM ${TABLE}
         WHERE publication_id = $1 AND owner_id = $2`,
        [previousId, ownerId]
      );

      if (!prior.rowCount) throw new Error('RESOURCE_NOT_FOUND');
      return publicValue(prior.rows[0]);
    }

    const duplicate = await client.query(
      `SELECT publication_id FROM ${TABLE}
       WHERE task_id = $1 AND platform = $2`,
      [taskId, value.platform]
    );

    if (duplicate.rowCount) {
      throw new Error('PUBLICATION_ALREADY_EXISTS');
    }

    const publicationId = randomUUID();

    const result = await client.query(
      `INSERT INTO ${TABLE}
       (publication_id, task_id, owner_id, platform,
        revision, metadata_hash, status, publication_data)
       VALUES ($1, $2, $3, $4, 1, $5, 'draft', $6::jsonb)
       RETURNING *`,
      [
        publicationId, taskId, ownerId,
        value.platform, hash(value), JSON.stringify(value)
      ]
    );

    await client.query(
      `INSERT INTO ${IDEMPOTENCY}
       (request_key, owner_id, fingerprint, resource_type, resource_id)
       VALUES ($1, $2, $3, 'publication', $4)`,
      [key, ownerId, fingerprint, publicationId]
    );

    return publicValue(result.rows[0]);
  });
}

// 2. List publications
export async function listCreatorPublications(pool, ownerId, taskId) {
  const task = await pool.query(
    `SELECT task_id FROM haejumi_dev.creator_tasks
     WHERE task_id = $1 AND owner_id = $2`,
    [taskId, ownerId]
  );

  if (!task.rowCount) return null;

  const result = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE task_id = $1 AND owner_id = $2
     ORDER BY created_at`,
    [taskId, ownerId]
  );

  return result.rows.map(publicValue);
}

// 3. Get publication
export async function getCreatorPublication(
  pool, ownerId, taskId, publicationId
) {
  const result = await pool.query(
    `SELECT * FROM ${TABLE}
     WHERE publication_id = $1
       AND task_id = $2
       AND owner_id = $3`,
    [publicationId, taskId, ownerId]
  );

  return result.rowCount ? publicValue(result.rows[0]) : null;
}

// 4. Update publication
export async function updateCreatorPublication(
  pool, ownerId, taskId, publicationId, input, idempotencyKey
) {
  const value = validateInput(input);
  requireKey(idempotencyKey);

  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error('VALIDATION_ERROR');
  }

  const fingerprint = JSON.stringify({
    publication_id: publicationId,
    revision: input.revision,
    ...value
  });

  const key = `${ownerId}:publication-update:${idempotencyKey}`;

  return transaction(pool, async client => {
    await requireTask(client, ownerId, taskId);

    const previousId = await findPrevious(client, key, fingerprint);

    if (previousId) {
      if (previousId !== publicationId) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }

      const previous = await client.query(
        `SELECT * FROM ${TABLE}
         WHERE publication_id = $1 AND owner_id = $2`,
        [publicationId, ownerId]
      );

      if (!previous.rowCount) throw new Error('RESOURCE_NOT_FOUND');
      return publicValue(previous.rows[0]);
    }

    const current = await client.query(
      `SELECT * FROM ${TABLE}
       WHERE publication_id = $1
         AND task_id = $2
         AND owner_id = $3
       FOR UPDATE`,
      [publicationId, taskId, ownerId]
    );

    if (!current.rowCount) throw new Error('RESOURCE_NOT_FOUND');

    const item = current.rows[0];

    if (item.platform !== value.platform) {
      throw new Error('VALIDATION_ERROR');
    }

    if (item.revision !== input.revision) {
      throw new Error('VERSION_CONFLICT');
    }

    let result = current;

    if (hash(value) !== item.metadata_hash) {
      await client.query(
        `UPDATE haejumi_dev.creator_publication_approvals
         SET status = 'invalidated'
         WHERE publication_id = $1 AND status = 'active'`,
        [publicationId]
      );

      result = await client.query(
        `UPDATE ${TABLE}
         SET revision = revision + 1,
             metadata_hash = $2,
             publication_data = $3::jsonb,
             status = 'draft',
             updated_at = NOW()
         WHERE publication_id = $1
         RETURNING *`,
        [publicationId, hash(value), JSON.stringify(value)]
      );
    }

    await client.query(
      `INSERT INTO ${IDEMPOTENCY}
       (request_key, owner_id, fingerprint, resource_type, resource_id)
       VALUES ($1, $2, $3, 'publication', $4)`,
      [key, ownerId, fingerprint, publicationId]
    );

    return publicValue(result.rows[0]);
  });
}