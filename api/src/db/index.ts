import pg from 'pg';
import { config } from '../config';

// Return bigint/numeric as numbers (counts, tolerances are small).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
// Without this handler, a dropped database connection (PostgreSQL restart, laptop sleep, DROP DATABASE … FORCE)
// is an unhandled 'error' event and crashes the whole API. Log it; the pool reconnects on the next query.
pool.on('error', (err) => console.error('[db] idle connection lost:', err.message));

export type Db = pg.Pool | pg.PoolClient;

/**
 * node-postgres only parses arrays of built-in types. Arrays of our enums (e.g. language[] from
 * array_agg(language)) would arrive as the raw string "{java,python}", so register the text[]
 * parser for every enum array type once the schema exists.
 */
let enumArrays: Promise<boolean> | null = null;
function ensureEnumArrayParsers(): Promise<boolean> {
  enumArrays ??= pool
    .query(`SELECT t.typarray AS oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' AND n.nspname = 'public' AND t.typarray <> 0`)
    .then((r) => {
      const textArray = pg.types.getTypeParser(1009 as any) as (v: string) => string[];
      for (const row of r.rows) pg.types.setTypeParser(Number(row.oid), textArray);
      if (!r.rows.length) enumArrays = null; // schema not migrated yet: try again later
      return r.rows.length > 0;
    })
    .catch(() => {
      enumArrays = null;
      return false;
    });
  return enumArrays;
}

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  await ensureEnumArrayParsers();
  const r = await db.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await q<T>(sql, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
