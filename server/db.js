import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export async function openDemoDatabase(path = '.data/demo') {
  if (path !== 'memory://') await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new PGlite(path);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  await db.exec('create table if not exists public.demo_migrations (name text primary key)');
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, migrations), 'utf8');
    await db.transaction(async (tx) => {
      if (name === '20261108074434_buildingconnect_initial.sql') {
        await tx.query('update public.demo_migrations set name=$1 where name=$2',
          [name, '20261108071951_buildingconnect_initial.sql']);
      }
      const { rows } = await tx.query('select name from public.demo_migrations where name = $1', [name]);
      if (rows.length) return;
      await tx.exec(sql);
      await tx.query('insert into public.demo_migrations values ($1)', [name]);
    });
  }
  return db;
}

export function openSupabaseDatabase(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  pool.on('error', (error) => console.error('Database connection:', error.code ?? error.name));
  return {
    query: (...args) => pool.query(...args),
    close: () => pool.end(),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await run(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
