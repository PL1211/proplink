import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const renamedMigrations = {
  '20261108074434_buildingconnect_initial.sql': '20261108071951_buildingconnect_initial.sql',
  '20261108161618_agent_and_photon_workflow.sql': '20261108151440_agent_and_photon_workflow.sql',
  '20261108164248_automatic_office_light_baseline.sql': '20261108163827_automatic_office_light_baseline.sql',
};

export async function openDemoDatabase(path = '.data/demo') {
  if (path !== 'memory://') await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new PGlite(path);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  await db.exec('create table if not exists public.demo_migrations (name text primary key)');
  for (const name of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, migrations), 'utf8');
    await db.transaction(async (tx) => {
      const oldName = renamedMigrations[name];
      if (oldName) {
        await tx.query('update public.demo_migrations set name=$1 where name=$2', [name, oldName]);
      }
      const { rows } = await tx.query('select name from public.demo_migrations where name = $1', [name]);
      if (rows.length) return;
      await tx.exec(sql);
      await tx.query('insert into public.demo_migrations values ($1)', [name]);
    });
  }
  return db;
}

export function openSupabaseDatabase(connectionString, certificate) {
  const url = new URL(connectionString);
  let ssl;
  if (certificate) {
    for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
    ssl = { ca: certificate, rejectUnauthorized: true };
  } else {
    url.searchParams.set('sslmode', 'verify-full');
  }
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idleTimeoutMillis: 5000,
    allowExitOnIdle: true,
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
