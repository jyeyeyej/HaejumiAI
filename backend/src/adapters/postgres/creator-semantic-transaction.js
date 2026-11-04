import {
  createCreatorFingerprint,
  createCreatorIdempotencyKeys
} from './creator-fingerprint.js';

export async function createCreatorSemanticTransaction(
  pool,
  { project, task, checkpoint, idempotencyKey, input }
) {
  if (!project || !task || !checkpoint || !input) {
    throw new Error('Creator transaction input is required');
  }

  const ownerId = project.ownerId;
  if (
    typeof ownerId !== 'string' || !ownerId ||
    typeof idempotencyKey !== 'string' || !idempotencyKey ||
    project.project_id !== task.project_id ||
    project.task_id !== task.task_id ||
    checkpoint.task_id !== task.task_id ||
    task.ownerId !== ownerId ||
    checkpoint.owner_id !== ownerId
  ) {
    throw new Error('Invalid Creator relations or idempotency key');
  }

  const fingerprint = createCreatorFingerprint(input);
  const { requestKey, semanticKey } =
    createCreatorIdempotencyKeys(ownerId, idempotencyKey, fingerprint);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 요청 키와 의미적 키를 고정된 순서로 잠급니다.
    const lockKeys = [requestKey, semanticKey].sort();
    for (const key of lockKeys) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [key]
      );
    }

    const requestResult = await client.query(
      `SELECT project_id, fingerprint, owner_id
       FROM haejumi_dev.creator_idempotency
       WHERE request_key = $1`,
      [requestKey]
    );

    if (requestResult.rowCount > 0) {
      const prior = requestResult.rows[0];

      if (prior.owner_id !== ownerId ||
          prior.fingerprint !== fingerprint) {
        const error = new Error('IDEMPOTENCY_CONFLICT');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }

      await client.query('COMMIT');
      return { project_id: prior.project_id, reused: true };
    }

    const semanticResult = await client.query(
      `SELECT project_id, fingerprint, owner_id
       FROM haejumi_dev.creator_idempotency
       WHERE request_key = $1`,
      [semanticKey]
    );

    if (semanticResult.rowCount > 0) {
      const prior = semanticResult.rows[0];

      if (prior.owner_id !== ownerId ||
          prior.fingerprint !== fingerprint) {
        const error = new Error('IDEMPOTENCY_CONFLICT');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }

      await client.query(
        `INSERT INTO haejumi_dev.creator_idempotency
         (request_key, owner_id, fingerprint, project_id)
         VALUES ($1, $2, $3, $4)`,
        [requestKey, ownerId, fingerprint, prior.project_id]
      );

      await client.query('COMMIT');
      return { project_id: prior.project_id, reused: true };
    }

    await client.query(
      `INSERT INTO haejumi_dev.creator_projects
       (project_id, owner_id, task_id, status,
        current_version, content_hash, project_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        project.project_id, ownerId, project.task_id,
        project.status, project.current_version,
        project.content_hash ?? null, JSON.stringify(project)
      ]
    );

    await client.query(
      `INSERT INTO haejumi_dev.creator_tasks
       (task_id, project_id, owner_id, status,
        current_version, content_hash, task_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        task.task_id, task.project_id, ownerId,
        task.status, task.current_version,
        task.content_hash ?? null, JSON.stringify(task)
      ]
    );

    await client.query(
      `INSERT INTO haejumi_dev.creator_checkpoints
       (checkpoint_id, task_id, owner_id, kind, status,
        content_version, content_hash, checkpoint_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        checkpoint.checkpoint_id, checkpoint.task_id,
        ownerId, checkpoint.kind, checkpoint.status,
        checkpoint.content_version,
        checkpoint.content_hash ?? null,
        JSON.stringify(checkpoint)
      ]
    );

    for (const key of [requestKey, semanticKey]) {
      await client.query(
        `INSERT INTO haejumi_dev.creator_idempotency
         (request_key, owner_id, fingerprint, project_id)
         VALUES ($1, $2, $3, $4)`,
        [key, ownerId, fingerprint, project.project_id]
      );
    }

    await client.query('COMMIT');

    return {
      project_id: project.project_id,
      task_id: task.task_id,
      checkpoint_id: checkpoint.checkpoint_id,
      reused: false
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

