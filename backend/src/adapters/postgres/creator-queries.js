export async function listCreatorProjects(pool, ownerId) {
  if (typeof ownerId !== 'string' || !ownerId) {
    throw new Error('ownerId is required');
  }

  const result = await pool.query(
    `SELECT project_data
     FROM haejumi_dev.creator_projects
     WHERE owner_id = $1
     ORDER BY created_at DESC, project_id DESC`,
    [ownerId]
  );

  return result.rows.map((row) => row.project_data);
}

export async function getCreatorProject(pool, ownerId, projectId) {
  if (typeof ownerId !== 'string' || !ownerId ||
      typeof projectId !== 'string' || !projectId) {
    throw new Error('ownerId and projectId are required');
  }

  const result = await pool.query(
    `SELECT project_data
     FROM haejumi_dev.creator_projects
     WHERE owner_id = $1 AND project_id = $2`,
    [ownerId, projectId]
  );

  return result.rows[0]?.project_data ?? null;
}
