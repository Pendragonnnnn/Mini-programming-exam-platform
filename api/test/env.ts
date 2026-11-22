/** Point the API at a separate test database before anything reads the config. */
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://aegis:aegis@127.0.0.1:5432/aegis_test';
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.SEB_REQUIRED = 'false';
process.env.RUNNER = process.env.RUNNER ?? 'local';
process.env.SMTP_HOST = '';

/** Create the test database if it doesn't exist yet. */
export async function prepareTestDb() {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(name) || !/test/i.test(name)) throw new Error(`Refusing to run tests on "${name}": the test database name must contain "test".`);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!r.rowCount) await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}
