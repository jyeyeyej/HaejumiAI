
export class PostgresCreatorRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async createProjectWithTask(project, task) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO haejumi_dev.creator_projects
         (project_id, owner_id, task_id, status, current_version, content_hash, project_data)
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
        `INSERT INTO haejumi_dev.creator_tasks
         (task_id, project_id, owner_id, status, current_version, content_hash, task_data)
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

      await client.query('COMMIT');

      return { project_id: project.project_id, task_id: task.task_id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProject(projectId, ownerId) {
    const result = await this.pool.query(
      `SELECT project_data
       FROM haejumi_dev.creator_projects
       WHERE project_id = $1 AND owner_id = $2`,
      [projectId, ownerId]
    );

    return result.rows[0]?.project_data ?? null;
  }

  async deleteProject(projectId, ownerId) {
    if (!projectId || !ownerId) {
      throw new Error('projectId and ownerId are required');
    }

    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      // Lock the project and check ownership.
      const projectResult = await client.query(
        `SELECT project_id
         FROM haejumi_dev.creator_projects
         WHERE project_id = $1 AND owner_id = $2
         FOR UPDATE`,
        [projectId, ownerId]
      );

      if (projectResult.rowCount === 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return { deleted: false, reason: 'NOT_FOUND' };
      }

      // Lock tasks and their existing render jobs.
      await client.query(
        `SELECT task_id
         FROM haejumi_dev.creator_tasks
         WHERE project_id = $1
         FOR UPDATE`,
        [projectId]
      );

      const renderResult = await client.query(
        `SELECT r.job_id, r.status
         FROM haejumi_dev.creator_render_jobs r
         JOIN haejumi_dev.creator_tasks t
           ON t.task_id = r.task_id
         WHERE t.project_id = $1
         FOR UPDATE OF r`,
        [projectId]
      );

      // Unknown statuses must be treated as unsafe.
      
const terminalStatuses = new Set([
  'succeeded',
  'completed',
  'failed',
  'cancelled',
  'canceled'
]);


      const activeRender = renderResult.rows.find(
        (job) => !terminalStatuses.has(job.status)
      );

      if (activeRender) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return {
          deleted: false,
          reason: 'ACTIVE_RENDER',
          status: activeRender.status
        };
      }

      // Publication idempotency has no declared foreign key.
      // Clean records associated with this project's resources.
      await client.query(
        `DELETE FROM haejumi_dev.creator_publication_idempotency
         WHERE owner_id = $2
           AND resource_id IN (
             SELECT t.task_id
             FROM haejumi_dev.creator_tasks t
             WHERE t.project_id = $1
             UNION
             SELECT p.publication_id
             FROM haejumi_dev.creator_publications p
             JOIN haejumi_dev.creator_tasks t
               ON t.task_id = p.task_id
             WHERE t.project_id = $1
             UNION
             SELECT a.approval_id
             FROM haejumi_dev.creator_publication_approvals a
             JOIN haejumi_dev.creator_tasks t
               ON t.task_id = a.task_id
             WHERE t.project_id = $1
           )`,
        [projectId, ownerId]
      );

      // Remove approval idempotency before approvals.
      await client.query(
        `DELETE FROM haejumi_dev.creator_approval_idempotency ai
         USING haejumi_dev.creator_approvals a,
               haejumi_dev.creator_tasks t
         WHERE ai.approval_id = a.approval_id
           AND a.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      // Remove render idempotency before render jobs.
      await client.query(
        `DELETE FROM haejumi_dev.creator_render_idempotency ri
         USING haejumi_dev.creator_render_jobs r,
               haejumi_dev.creator_tasks t
         WHERE ri.job_id = r.job_id
           AND r.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      // Publication approvals reference publications and tasks.
      await client.query(
        `DELETE FROM haejumi_dev.creator_publication_approvals a
         USING haejumi_dev.creator_tasks t
         WHERE a.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      await client.query(
        `DELETE FROM haejumi_dev.creator_publications p
         USING haejumi_dev.creator_tasks t
         WHERE p.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      // Checkpoint approvals must be removed before checkpoints.
      await client.query(
        `DELETE FROM haejumi_dev.creator_approvals a
         USING haejumi_dev.creator_tasks t
         WHERE a.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      await client.query(
        `DELETE FROM haejumi_dev.creator_checkpoints c
         USING haejumi_dev.creator_tasks t
         WHERE c.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      await client.query(
        `DELETE FROM haejumi_dev.creator_render_jobs r
         USING haejumi_dev.creator_tasks t
         WHERE r.task_id = t.task_id
           AND t.project_id = $1`,
        [projectId]
      );

      await client.query(
        `DELETE FROM haejumi_dev.creator_tasks
         WHERE project_id = $1`,
        [projectId]
      );

      await client.query(
        `DELETE FROM haejumi_dev.creator_idempotency
         WHERE project_id = $1 AND owner_id = $2`,
        [projectId, ownerId]
      );

      const deleted = await client.query(
        `DELETE FROM haejumi_dev.creator_projects
         WHERE project_id = $1 AND owner_id = $2
         RETURNING project_id`,
        [projectId, ownerId]
      );

      if (deleted.rowCount !== 1) {
        throw new Error('PROJECT_DELETE_INCONSISTENT');
      }

      await client.query('COMMIT');
      transactionStarted = false;

      return {
        deleted: true,
        projectId
      };
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
