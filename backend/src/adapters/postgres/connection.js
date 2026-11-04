import pg from 'pg';

export function createPostgresPool(config = {}) {
  return new pg.Pool({
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 5434,
    database: config.database ?? 'haejumi',
    user: config.user ?? 'haejumi_user',
    password: config.password ?? process.env.HAEJUMI_PG_PASSWORD,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  });
}

export async function checkPostgresConnection(pool) {
  const result = await pool.query(
    'SELECT current_database() AS database, current_user AS username'
  );
  return result.rows[0];
}
