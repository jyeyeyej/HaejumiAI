import { randomUUID, createHash } from 'node:crypto';

export async function approveCreatorPlan(pool, { ownerId, taskId, checkpointId, contentVersion, contentHash }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const taskResult = await client.query(
      `SELECT * FROM haejumi_dev.creator_tasks
       WHERE task_id = $1 AND owner_id = $2
       FOR UPDATE`,
      [taskId, ownerId]
    );

    if (taskResult.rowCount === 0) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const task = taskResult.rows[0];

    const checkpointResult = await client.query(
      `SELECT * FROM haejumi_dev.creator_checkpoints
       WHERE checkpoint_id = $1 AND task_id = $2 AND owner_id = $3
       FOR UPDATE`,
      [checkpointId, taskId, ownerId]
    );

    if (checkpointResult.rowCount === 0) {
      throw new Error('RESOURCE_NOT_FOUND');
    }

    const checkpoint = checkpointResult.rows[0];

    if (checkpoint.status === 'approved') {
      const existing = await client.query(
        'SELECT approval_data FROM haejumi_dev.creator_approvals WHERE checkpoint_id = $1',
        [checkpointId]
      );
      if (existing.rowCount !== 1) throw new Error('INVALID_STATE_TRANSITION');
      await client.query('COMMIT');
      return existing.rows[0].approval_data;
    }

    if (
      checkpoint.kind !== 'plan' ||
      checkpoint.status !== 'pending' ||
      task.status !== 'waiting_plan_approval'
    ) {
      throw new Error('INVALID_STATE_TRANSITION');
    }

    if (
      task.current_version !== contentVersion ||
      checkpoint.content_version !== contentVersion ||
      task.content_hash !== contentHash ||
      checkpoint.content_hash !== contentHash
    ) {
      throw new Error('VERSION_CONFLICT');
    }

    const approvalId = randomUUID();
    const approvedAt = new Date().toISOString();
    const payload = JSON.stringify({
      task_id: taskId,
      checkpoint_id: checkpointId,
      content_version: contentVersion,
      content_hash: contentHash,
      approval_scope: 'continue'
    });
    const approvalHash = createHash('sha256').update(payload).digest('hex');

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
       (approval_id, task_id, checkpoint_id, content_version,
        content_hash, approval_scope, status, approval_hash,
        approved_at, approval_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        approvalId, taskId, checkpointId, contentVersion,
        contentHash, 'continue', 'active', approvalHash,
        approvedAt, JSON.stringify(approval)
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_checkpoints
       SET status = 'approved',
           checkpoint_data = checkpoint_data || $2::jsonb
       WHERE checkpoint_id = $1`,
      [checkpointId, JSON.stringify({ status: 'approved', approval_id: approvalId })]
    );

    const draftCheckpointId = randomUUID();
    await client.query(
      `INSERT INTO haejumi_dev.creator_checkpoints
       (checkpoint_id, task_id, owner_id, kind, status,
        content_version, content_hash, checkpoint_data)
       VALUES ($1,$2,$3,'draft','pending',$4,$5,$6)`,
      [
        draftCheckpointId, taskId, ownerId,
        contentVersion, contentHash,
        JSON.stringify({
          checkpoint_id: draftCheckpointId,
          task_id: taskId,
          owner_id: ownerId,
          kind: 'draft',
          status: 'pending',
          content_version: contentVersion,
          content_hash: contentHash,
          approval_scope: 'continue'
        })
      ]
    );

    await client.query(
      `UPDATE haejumi_dev.creator_tasks
       SET status = 'waiting_draft_approval',
           task_data = task_data || $2::jsonb,
           updated_at = NOW()
       WHERE task_id = $1`,
      [
        taskId,
        JSON.stringify({
          status: 'waiting_draft_approval',
          next_action: 'review_draft'
        })
      ]
    );

    await client.query('COMMIT');
    return approval;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
