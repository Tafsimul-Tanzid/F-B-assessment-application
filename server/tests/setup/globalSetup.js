import pg from 'pg';

/**
 * Creates the test database (once, before any test file) if it does not exist.
 *
 * Tests run against a real PostgreSQL instance rather than a mock or SQLite.
 * That is not incidental: what these tests exist to prove — row locking,
 * guarded updates re-evaluated after a lock wait, per-outlet receipt
 * sequencing under concurrency — is behaviour of the database engine itself.
 * A mock would assert that the code calls the functions we wrote, which is not
 * the same claim at all.
 */
export default async function globalSetup() {
  process.env.NODE_ENV = 'test';

  const dbName = process.env.DB_NAME ?? 'fnb_pos_test';
  const admin = new pg.Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: 'postgres',
  });

  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rowCount === 0) {
    // Identifier cannot be parameterised; dbName comes from config, not input.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();
}
