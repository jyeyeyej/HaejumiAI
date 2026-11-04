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
}
