import fs from 'node:fs';
import path from 'node:path';
import { pool } from './index';

export async function migrate(): Promise<void> {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  try {
    const has = await c.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    const done = new Set<string>();
    if (has.rows[0].t) {
      for (const r of (await c.query('SELECT name FROM schema_migrations')).rows) done.add(r.name);
    }
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(`[migrate] applied ${f}`);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
