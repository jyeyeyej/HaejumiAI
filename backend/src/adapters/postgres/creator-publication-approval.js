import { randomUUID, createHash } from 'node:crypto';

const DB = 'haejumi_dev';

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function requireKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('VALIDATION_ERROR');
  }
}

function validateApprovalInput(input) {
  const fields = [
    'content_version',
    'content_hash',
    'artifact_sha256',
    'publication_revision',
    'publication_hash'
  ];

  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some(key => !fields.includes(key)) ||
    !Number.isSafeInteger(input.content_version) ||
    typeof input.content_hash !== 'string' ||
    typeof input.artifact_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(input.artifact_sha256) ||
    !Number.isSafeInteger(input.publication_revision) ||
    typeof input.publication_hash !== 'string'
  ) {
    throw new Error('VALIDATION_ERROR');
  }
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

async function invalidateStaleApprovals(client, task) {
  const result = await client.query(
    `UPDATE ${DB}.creator_publication_approvals
     SET status = 'invalidated'
     WHERE task_id = $1
       AND status = 'active'
       AND (
         content_version <> $2
         OR content_hash <> $3
       )
     RETURNING publication_id`,
    [task.task_id, task.current_version, task.content_hash]
  );

  const ids = result.rows.map(row => row.publication_id);

  if (ids.length) {
    await client.query(
      `UPDATE ${DB}.creator_publications
       SET status = 'draft', updated_at = NOW()
       WHERE publication_id = ANY($1::uuid[])`,
      [ids]
    );
  }

  return ids.length;
}

// 콘텐츠 변경 후 호출할 승인 무효화 함수
export async function invalidateCreatorPublicationApprovals(
  pool, ownerId, taskId
) {
  return transaction(pool, async client => {
    const result = await client.query(
      `SELECT * FROM ${DB}.creator_tasks
       WHERE task_id = $1 AND owner_id = $2
       FOR UPDATE`,
      [taskId, ownerId]
    );

    if (!result.rowCount) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    return invalidateStaleApprovals(client, result.rows[0]);
  });
}

// 플랫폼별 최종 게시 승인
export async function approveCreatorPublication(
  pool,
  {
    ownerId,
    taskId,
    publicationId,
    input,
    idempotencyKey,
    verifyRights
  }
) {
  requireKey(idempotencyKey);
  validateApprovalInput(input);

  // 실제 서비스에서는 검증된 권리 검사기를 반드시 연결
  if (typeof verifyRights !== 'function') {
    throw new Error('RIGHTS_REVIEW_REQUIRED');
  }

  return transaction(pool, async client => {
    const tasks = await client.query(
      `SELECT * FROM ${DB}.creator_tasks
       WHERE task_id = $1 AND owner_id = $2
       FOR UPDATE`,
      [taskId, ownerId]
    );

    if (!tasks.rowCount) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const task = tasks.rows[0];

    await invalidateStaleApprovals(client, task);

    const publications = await client.query(
      `SELECT * FROM ${DB}.creator_publications
       WHERE publication_id = $1
         AND task_id = $2
         AND owner_id = $3
       FOR UPDATE`,
      [publicationId, taskId, ownerId]
    );

    if (!publications.rowCount) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const publication = publications.rows[0];

    if (task.status !== 'preview_approved') {
      throw new Error('RENDER_REQUIRED');
    }

    const jobs = await client.query(
      `SELECT *
       FROM ${DB}.creator_render_jobs
       WHERE task_id = $1
         AND owner_id = $2
         AND status = 'succeeded'
         AND content_version = $3
         AND content_hash = $4
         AND job_data->>'renderer_mode' = 'ffmpeg'
         AND job_data->>'artifact_verified' = 'true'
         AND job_data->>'artifact_sha256' ~ '^[a-f0-9]{64}$'
       ORDER BY
         (job_data->>'completed_at') DESC NULLS LAST,
         updated_at DESC,
         job_id DESC
       LIMIT 1`,
      [
        taskId,
        ownerId,
        task.current_version,
        task.content_hash
      ]
    );

    if (!jobs.rowCount) {
      throw new Error('RENDER_REQUIRED');
    }

    const job = jobs.rows[0];

    const previews = await client.query(
      `SELECT c.checkpoint_id
       FROM ${DB}.creator_checkpoints c
       JOIN ${DB}.creator_approvals a
         ON a.checkpoint_id = c.checkpoint_id
       WHERE c.task_id = $1
         AND c.owner_id = $2
         AND c.kind = 'preview'
         AND c.status = 'approved'
         AND c.content_version = $3
         AND c.content_hash = $4
         AND a.approval_scope = 'continue'
         AND a.status = 'active'
         AND a.content_version = $3
         AND a.content_hash = $4
       LIMIT 1`,
      [
        taskId,
        ownerId,
        task.current_version,
        task.content_hash
      ]
    );

    if (!previews.rowCount) {
      throw new Error('RENDER_REQUIRED');
    }

    const expected = {
      content_version: task.current_version,
      content_hash: task.content_hash,
      artifact_sha256: job.job_data.artifact_sha256,
      publication_revision: publication.revision,
      publication_hash: publication.metadata_hash
    };

    for (const [key, value] of Object.entries(expected)) {
      if (input[key] !== value) {
        throw new Error('VERSION_CONFLICT');
      }
    }

    const projects = await client.query(
      `SELECT *
       FROM ${DB}.creator_projects
       WHERE project_id = $1
         AND owner_id = $2`,
      [task.project_id, ownerId]
    );

    if (!projects.rowCount) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    // 권리 검증에 성공했다는 명시적 결과만 인정
    const rightsPassed = await verifyRights({
      ownerId,
      project: projects.rows[0],
      task,
      publication,
      job
    });

    if (rightsPassed !== true) {
      throw new Error('RIGHTS_REVIEW_REQUIRED');
    }

    const approvalPayload = {
      task_id: taskId,
      publication_id: publicationId,
      platform: publication.platform,
      ...publication.publication_data,
      ...expected
    };

    const fingerprint = JSON.stringify(approvalPayload);
    const approvalHash = hash(approvalPayload);
    const requestKey =
      `${ownerId}:publication-approval:${idempotencyKey}`;

    const previous = await client.query(
      `SELECT * FROM ${DB}.creator_publication_idempotency
       WHERE request_key = $1`,
      [requestKey]
    );

    if (previous.rowCount) {
      const prior = previous.rows[0];

      if (
        prior.fingerprint !== fingerprint ||
        prior.resource_type !== 'approval'
      ) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }

      const existing = await client.query(
        `SELECT *
         FROM ${DB}.creator_publication_approvals
         WHERE approval_id = $1 AND owner_id = $2`,
        [prior.resource_id, ownerId]
      );

      if (!existing.rowCount) {
        throw new Error('INVALID_STATE_TRANSITION');
      }

      return existing.rows[0];
    }

    const active = await client.query(
      `SELECT *
       FROM ${DB}.creator_publication_approvals
       WHERE publication_id = $1
         AND status = 'active'
       FOR UPDATE`,
      [publicationId]
    );

    let approval;

    if (active.rowCount) {
      if (active.rows[0].approval_hash !== approvalHash) {
        throw new Error('VERSION_CONFLICT');
      }
      approval = active.rows[0];
    } else {
      const approvalId = randomUUID();

      const inserted = await client.query(
        `INSERT INTO ${DB}.creator_publication_approvals
         (approval_id, publication_id, task_id, owner_id,
          content_version, content_hash, artifact_sha256,
          publication_revision, publication_hash,
          approval_hash, status, approval_data)
         VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11::jsonb)
         RETURNING *`,
        [
          approvalId,
          publicationId,
          taskId,
          ownerId,
          expected.content_version,
          expected.content_hash,
          expected.artifact_sha256,
          expected.publication_revision,
          expected.publication_hash,
          approvalHash,
          JSON.stringify(approvalPayload)
        ]
      );

      approval = inserted.rows[0];
    }

    await client.query(
      `UPDATE ${DB}.creator_publications
       SET status = 'publish_ready',
           updated_at = NOW()
       WHERE publication_id = $1`,
      [publicationId]
    );

    await client.query(
      `INSERT INTO ${DB}.creator_publication_idempotency
       (request_key, owner_id, fingerprint,
        resource_type, resource_id)
       VALUES ($1,$2,$3,'approval',$4)`,
      [requestKey, ownerId, fingerprint, approval.approval_id]
    );

    return approval;
  });
}