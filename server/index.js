import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { createApp } from './app.js';
import { openDemoDatabase, openSupabaseDatabase } from './db.js';
import { createDemo } from './demo.js';

const mode = process.env.APP_MODE ?? 'demo';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5173);
const dev = process.argv.includes('--dev');
if (!['demo', 'supabase'].includes(mode)) throw new Error('APP_MODE must be demo or supabase.');
if (mode === 'demo' && host !== '127.0.0.1') throw new Error('Demo mode must bind to 127.0.0.1.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');

const { DATABASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEVICE_TOKEN } = process.env;
if (mode === 'supabase' && (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_') ||
    (DEVICE_TOKEN?.length ?? 0) < 32)) {
  throw new Error('Supabase mode requires DATABASE_URL, SUPABASE_URL, a publishable key, and a device token of at least 32 characters.');
}
const db = mode === 'demo' ? await openDemoDatabase(process.env.DEMO_DB_PATH) : openSupabaseDatabase(DATABASE_URL);
await db.query('select id from bc.devices limit 1');
const simulator = mode === 'demo' ? await createDemo(db) : null;
const auth = mode === 'supabase' ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}).auth : null;

const app = createApp({
  db, auth, simulator, deviceToken: DEVICE_TOKEN,
  publicConfig: auth ? { url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY } : {},
});
const server = createServer(app);
const vite = dev ? await (await import('vite')).createServer({
  server: { middlewareMode: { server }, hmr: { server } },
}) : null;
app.use(vite ? vite.middlewares : express.static('dist'));
server.listen(port, host, () => console.log(`BuildingConnect (${mode}) http://${host}:${port}`));

async function shutdown() {
  simulator?.stop();
  await vite?.close();
  server.close();
  await db.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
