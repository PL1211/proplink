import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { openSupabaseDatabase } from './db.js';
import { createPhotonClient, sendMessageJob } from './dispatch-work.js';
import { integrationConfig } from './integration-config.js';
import { claimJob, finishJob } from './jobs.js';
import { failInvestigation, investigateJob } from './nemotron.js';
import { activity, one } from './workflow.js';

export function createIntegrationWorker(db, config, {
  photon = config.photon && createPhotonClient(config.photon),
  run,
} = {}) {
  const kinds = [
    ...(config.openrouter ? ['investigate'] : []),
    ...(photon ? ['owner_approval', 'owner_question', 'technician_message', 'owner_update', 'reply_help'] : []),
  ];

  async function handleFailure(job, reason) {
    await db.transaction(async (tx) => {
      const row = await one(tx, 'select delivery_started_at from bc.integration_jobs where id=$1 and lease_id=$2', [job.id, job.lease_id]);
      if (!row) return;
      const started = row.delivery_started_at !== null;
      const retry = !started && job.attempts < 3;
      const status = started ? 'uncertain' : retry ? 'pending' : 'failed';
      const detail = reason ?? (started ? 'Provider outcome requires reconciliation' : 'Provider job failed');
      if (!await finishJob(tx, job, { status, error: detail, delay: retry ? job.attempts * 5 : 0 }) || retry) return;
      if (job.kind === 'investigate') {
        await failInvestigation(tx, job, config);
      } else if (job.kind !== 'reply_help') {
        const incident = await one(tx, 'select building_id from bc.incidents where id=$1', [job.incident_id]);
        await activity(tx, incident.building_id, job.incident_id, 'communication',
          status === 'uncertain' ? 'Provider outcome uncertain. Check the provider before contacting again.' :
            'Automatic communication failed. Check the provider and use the dashboard to record progress.');
      }
    });
  }

  async function tick() {
    if (!kinds.length) return false;
    const job = await claimJob(db, kinds);
    if (!job) return false;
    try {
      if (job.delivery_started_at) await handleFailure(job);
      else if (job.kind === 'investigate') await investigateJob(db, job, config, run);
      else await sendMessageJob(db, job, config, photon);
    } catch (error) {
      const providerError = /^OpenRouter HTTP \d{3}$/.test(error.message) ? error.message : undefined;
      await handleFailure(job, providerError);
      console.error('Integration job:', job.kind, job.id, providerError ?? error.code ?? error.name);
    }
    return true;
  }
  return { tick, enabled: Boolean(kinds.length), close: () => photon?.close() };
}

async function main() {
  const config = integrationConfig(process.env);
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to run the integration worker.');
  const db = openSupabaseDatabase(process.env.DATABASE_URL, process.env.DATABASE_CA_CERT);
  const worker = createIntegrationWorker(db, config);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  try {
    if (!worker.enabled) throw new Error('Configure OpenRouter or Photon to run the integration worker.');
    await db.query('select id from bc.integration_jobs limit 1');
    console.log('BuildingConnect integration worker is running.');
    while (!stop.signal.aborted) {
      try {
        if (await worker.tick()) continue;
      } catch (error) {
        console.error('Integration worker:', error.code ?? error.name);
      }
      await sleep(2000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    try { await worker.close(); } finally { await db.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Worker startup:', error.message); process.exitCode = 1; });
}
