import { randomUUID, createHash } from 'node:crypto';

const transitions = {
  plan: {
    before: 'waiting_plan_approval',
    after: 'waiting_draft_approval',
    nextAction: 'review_draft'
  },
  draft: {
    before: 'waiting_draft_approval',
    after: 'render_ready',
    nextAction: 'none'
  },
  preview: {
    before: 'waiting_preview_approval',
    after: 'preview_approved',
    nextAction: 'none'
  }
};

export async function approveCreatorCheckpoint(pool, {
  ownerId, taskId, checkpointId, contentVersion, contentHash,
  idempotencyKey
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const taskResult = await client.query(
      `SELECT * FROM haejumi_dev.creator_tasks
       WHERE task_id = $1 AND owner_id = $2
       FOR UPDATE`,
      [taskId, ownerId]
    );

    if (taskResult.rowCount !== 1) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const task = taskResult.rows[0];

    if (typeof idempotencyKey !== 'string' ||
        !idempotencyKey.trim()) {
      throw new Error('VALIDATION_ERROR');
    }

    const requestKey = `${ownerId}:approval:${idempotencyKey}`;

    const fingerprint = JSON.stringify({
      task_id: taskId,
      checkpoint_id: checkpointId,
      content_version: contentVersion,
      content_hash: contentHash,
      approval_scope: 'continue'
    });

    const priorResult = await client.query(
      `SELECT approval_id, fingerprint
       FROM haejumi_dev.creator_approval_idempotency
       WHERE request_key = $1`,
      [requestKey]
    );

    if (priorResult.rowCount > 0) {
      const prior = priorResult.rows[0];

      if (prior.fingerprint !== fingerprint) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }

      const existing = await client.query(
        `SELECT approval_data
         FROM haejumi_dev.creator_approvals
         WHERE approval_id = $1 AND task_id = $2`,
        [prior.approval_id, taskId]
      );

      if (existing.rowCount !== 1) {
        throw new Error('INVALID_STATE_TRANSITION');
      }

      await client.query('COMMIT');
      return existing.rows[0].approval_data;
    }

    const checkpointResult = await client.query(
      `SELECT * FROM haejumi_dev.creator_checkpoints
       WHERE checkpoint_id = $1
         AND task_id = $2
         AND owner_id = $3
       FOR UPDATE`,
      [checkpointId, taskId, ownerId]
    );

    if (checkpointResult.rowCount !== 1) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const checkpoint = checkpointResult.rows[0];

    if (checkpoint.status === 'approved') {
      const existing = await client.query(
        `SELECT approval_data
         FROM haejumi_dev.creator_approvals
         WHERE checkpoint_id = $1`,
        [checkpointId]
      );

      if (existing.rowCount !== 1) {
        throw new Error('INVALID_STATE_TRANSITION');
      }

      await client.query('COMMIT');
      return existing.rows[0].approval_data;
    }

    const transition = transitions[checkpoint.kind];

    if (!transition ||
        checkpoint.status !== 'pending' ||
        task.status !== transition.before) {
      throw new Error('INVALID_STATE_TRANSITION');
    }

    if (task.current_version !== contentVersion ||
        checkpoint.content_version !== contentVersion ||
        task.content_hash !== contentHash ||
        checkpoint.content_hash !== contentHash) {
      throw new Error('VERSION_CONFLICT');
    }

    if (checkpoint.kind === 'draft') {
      const plan = await client.query(
        `SELECT checkpoint_id
         FROM haejumi_dev.creator_checkpoints
         WHERE task_id = $1
           AND owner_id = $2
           AND kind = 'plan'
           AND status = 'approved'
           AND content_version = $3
           AND content_hash = $4`,
        [taskId, ownerId, contentVersion, contentHash]
      );

      if (plan.rowCount === 0) {
        throw new Error('INVALID_STATE_TRANSITION');
      }
    }

    const approvalId = randomUUID();
    const approvedAt = new Date().toISOString();

    const approvalPayload = JSON.stringify({
      task_id: taskId,
      checkpoint_id: checkpointId,
      content_version: contentVersion,
      content_hash: contentHash,
      approval_scope: 'continue'
    });

    const approvalHash = createHash('sha256')
      .update(approvalPayload)
      .digest('hex');

    const approval = {
      approval_id: approvalId,
      task_id: taskId,
      checkpoint_id: checkpointId,
      content_version: contentVersion,
      content_hash: contentHash,
      approval_scope: 'continue',
      status: 'active',
      approval_hash: approvalHash,
      approved_at: approvedAt
    };

    await client.query(
      `INSERT INTO haejumi_dev.creator_approvals
       (approval_id, task_id, checkpoint_id,
        content_version, content_hash, approval_scope,
        status, approval_hash, approved_at, approval_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        approvalId, taskId, checkpointId,
        contentVersion, contentHash, 'continue',
        'active', approvalHash, approvedAt,
        JSON.stringify(approval)
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_checkpoints
       SET status = 'approved',
           checkpoint_data = checkpoint_data || $2::jsonb
       WHERE checkpoint_id = $1`,
      [
        checkpointId,
        JSON.stringify({
          status: 'approved',
          approval_id: approvalId
        })
      ]
    );

    if (checkpoint.kind === 'plan') {
      const draftId = randomUUID();

      const draft = {
        checkpoint_id: draftId,
        task_id: taskId,
        owner_id: ownerId,
        kind: 'draft',
        status: 'pending',
        content_version: contentVersion,
        content_hash: contentHash,
        approval_scope: 'continue'
      };

      await client.query(
        `INSERT INTO haejumi_dev.creator_checkpoints
         (checkpoint_id, task_id, owner_id, kind,
          status, content_version, content_hash,
          checkpoint_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          draftId, taskId, ownerId, 'draft',
          'pending', contentVersion, contentHash,
          JSON.stringify(draft)
        ]
      );
    }

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = $2,
           task_data = task_data || $3::jsonb,
           updated_at = NOW()
       WHERE task_id = $1`,
      [
        taskId,
        transition.after,
        JSON.stringify({
          status: transition.after,
          next_action: transition.nextAction,
          updated_at: new Date().toISOString()
        })
      ]
    );

    await client.query(
      `INSERT INTO haejumi_dev.creator_approval_idempotency
       (request_key, owner_id, fingerprint, approval_id)
       VALUES ($1, $2, $3, $4)`,
      [requestKey, ownerId, fingerprint, approvalId]
    );

    await client.query('COMMIT');
    return approval;

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 원래 오류를 유지합니다.
    }

    if (
      error.code === '23505' &&
      error.constraint === 'creator_approval_idempotency_pkey'
    ) {
      const conflict = new Error('IDEMPOTENCY_CONFLICT');
      conflict.code = 'IDEMPOTENCY_CONFLICT';
      throw conflict;
    }

    throw error;
  } finally {
    client.release();
  }
}
