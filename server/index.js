import { createServer } from 'node:http';
import express from 'express';
import { createApp } from './app.js';
import { openDemoDatabase } from './db.js';
import { createDemo } from './demo.js';
import { createSupabaseRuntime } from './supabase.js';

const mode = process.env.APP_MODE ?? 'demo';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5173);
const dev = process.argv.includes('--dev');
if (!['demo', 'supabase'].includes(mode)) throw new Error('APP_MODE must be demo or supabase.');
if (mode === 'demo' && host !== '127.0.0.1') throw new Error('Demo mode must bind to 127.0.0.1.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');

let simulator;
let runtime;
if (mode === 'demo') {
  const db = await openDemoDatabase(process.env.DEMO_DB_PATH);
  simulator = await createDemo(db);
  runtime = { db, app: createApp({ db, simulator, deviceToken: process.env.DEVICE_TOKEN }) };
} else {
  runtime = createSupabaseRuntime();
  await runtime.db.query('select id from bc.devices limit 1');
}
const { app, db } = runtime;
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
