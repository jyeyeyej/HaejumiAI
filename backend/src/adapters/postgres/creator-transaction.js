const TABLE = 'haejumi_dev';

function requireValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required');
  }
}

export async function createCreatorWithCheckpoint(
  pool,
  { project, task, checkpoint, idempotency }
) {
  if (!project || !task || !checkpoint || !idempotency) {
    throw new Error('Project, task, checkpoint and idempotency are required');
  }

  requireValue(idempotency.request_key, 'request_key');
  requireValue(idempotency.fingerprint, 'fingerprint');

  if (
    project.task_id !== task.task_id ||
    project.project_id !== task.project_id ||
    checkpoint.task_id !== task.task_id ||
    project.ownerId !== task.ownerId ||
    checkpoint.owner_id !== project.ownerId ||
    idempotency.owner_id !== project.ownerId
  ) {
    throw new Error('Creator relations do not match');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 동일 요청 키를 처리하는 트랜잭션을 직렬화합니다.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [idempotency.owner_id + ':' + idempotency.request_key]
    );

    const previous = await client.query(
      `SELECT project_id, fingerprint, owner_id
       FROM ${TABLE}.creator_idempotency
       WHERE request_key = $1`,
      [idempotency.request_key]
    );

    if (previous.rowCount > 0) {
      const record = previous.rows[0];

      if (
        record.owner_id !== idempotency.owner_id ||
        record.fingerprint !== idempotency.fingerprint
      ) {
        const error = new Error('IDEMPOTENCY_CONFLICT');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }

      await client.query('COMMIT');

      return {
        project_id: record.project_id,
        reused: true
      };
    }

    await client.query(
      `INSERT INTO ${TABLE}.creator_projects
       (project_id, owner_id, task_id, status,
        current_version, content_hash, project_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        project.project_id,
        project.ownerId,
        project.task_id,
        project.status,
        project.current_version,
        project.content_hash ?? null,
        JSON.stringify(project)
      ]
    );

    await client.query(
      `INSERT INTO ${TABLE}.creator_tasks
       (task_id, project_id, owner_id, status,
        current_version, content_hash, task_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        task.task_id,
        task.project_id,
        task.ownerId,
        task.status,
        task.current_version,
        task.content_hash ?? null,
        JSON.stringify(task)
      ]
    );

    await client.query(
      `INSERT INTO ${TABLE}.creator_checkpoints
       (checkpoint_id, task_id, owner_id, kind, status,
        content_version, content_hash, checkpoint_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        checkpoint.checkpoint_id,
        checkpoint.task_id,
        checkpoint.owner_id,
        checkpoint.kind,
        checkpoint.status,
        checkpoint.content_version,
        checkpoint.content_hash ?? null,
        JSON.stringify(checkpoint)
      ]
    );

    await client.query(
      `INSERT INTO ${TABLE}.creator_idempotency
       (request_key, owner_id, fingerprint, project_id)
       VALUES ($1, $2, $3, $4)`,
      [
        idempotency.request_key,
        idempotency.owner_id,
        idempotency.fingerprint,
        project.project_id
      ]
    );

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
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}
