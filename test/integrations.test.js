import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { openDemoDatabase } from '../server/db.js';
import { demoOwner, demoSnapshot } from '../server/demo.js';
import { integrationConfig } from '../server/integration-config.js';
import { createIntegrationWorker } from '../server/integration-worker.js';
import { runNemotron } from '../server/nemotron.js';
import { advanceWork, ingest, state } from '../server/workflow.js';

const ownerPhone = '+14155550101';
const technicianPhone = '+14155550102';
const config = integrationConfig({
  OPENROUTER_API_KEY: 'fixture-key',
  MONITOR_DATA_CENTER_IR: 'true',
  PHOTON_ENABLED: 'true',
  SPECTRUM_PROJECT_ID: 'fixture-project',
  SPECTRUM_PROJECT_SECRET: 'fixture-project-secret',
  SPECTRUM_WEBHOOK_SECRET: 'fixture-signing-secret',
  PHOTON_CONTACTS: JSON.stringify({
    office: { ownerUserId: demoOwner, ownerPhone, technicianPhone },
    data_center: { ownerUserId: demoOwner, ownerPhone, technicianPhone },
  }),
});

function sample(sequence, captured, { dark = true, ir = false } = {}) {
  const outputs = Object.fromEntries(['office', 'data_center'].map((building) => [
    building, { leds: [true, true, true], fan: 'running' },
  ]));
  return { ...demoSnapshot({ boot: 'bench-fixture', sequence, captured, dark, ir, outputs }), source: 'hardware' };
}

test('shared Photon iMessage replies survive worker restart and use the existing approval and repair gates', async (t) => {
  const db = await openDemoDatabase('memory://');
  t.after(() => db.close());
  await db.query('insert into bc.memberships select $1,id from bc.buildings', [demoOwner]);
  const baseline = 891 / 1023;
  await db.query("update bc.buildings set light_baseline_ratio=$1,light_min_ratio=$2 where id='office'", [baseline, baseline * 0.65]);

  const server = createApp({ db, integrations: config }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function webhook(body, { sender = ownerPhone, messageId = body, signatureOK = true } = {}) {
    const assignedLine = sender === ownerPhone ? '+14155550103' : '+14155550104';
    const raw = JSON.stringify({ event: 'message', message: {
      id: messageId, direction: 'inbound', platform: 'imessage',
      space: { id: `iMessage;-;${sender}`, type: 'dm', phone: assignedLine },
      sender: { id: sender, address: sender }, content: { type: 'text', text: body },
    } });
    const time = Math.floor(Date.now() / 1000).toString();
    const mac = createHmac('sha256', config.photon.webhookSecret).update(`v0:${time}:${raw}`).digest('hex');
    return (await fetch(`http://127.0.0.1:${server.address().port}/api/photon/webhook`, {
      method: 'POST', body: raw, headers: {
        'content-type': 'application/json', 'x-spectrum-timestamp': time,
        'x-spectrum-signature': signatureOK ? `v0=${mac}` : 'v0=invalid',
      },
    })).status;
  }

  const messages = [];
  const clients = {
    photon: { open: async (recipient) => ({
      id: `any;-;${recipient}`, type: 'dm', phone: 'shared',
      async send(body) {
        messages.push({ recipient, body });
        return { id: `fixture-message-${messages.length}` };
      },
    }) },
    async run(options) {
      let turn = 0;
      return runNemotron({ ...options, fetcher: async (url, request) => {
        const { messages } = JSON.parse(request.body);
        const steps = ['get_incident', 'get_sensor_history', 'search_verified_repairs', 'submit_assessment'];
        const name = steps[turn++];
        if (name === 'get_sensor_history') assert.equal(JSON.parse(messages.at(-1).content).kind, 'high_light');
        if (name === 'search_verified_repairs') assert.equal(JSON.parse(messages.at(-1).content).at(-1).sensors.light.raw, 990);
        const outcome = options.ownerReply ? 'inspect' : 'clarify';
        const args = name === 'submit_assessment' ? {
          outcome, observation: 'Light was above the bench threshold.', uncertainty: 'An extra light source is possible.',
          recommendation: 'Inspect the lighting circuit.', repair_ids: [],
          ...(outcome === 'clarify' ? { question: 'Was an extra light source turned on?' } : {}),
        } : {};
        return Response.json({ choices: [{ message: { tool_calls: [
          { id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ] } }] });
      } });
    },
  };
  let worker = createIntegrationWorker(db, config, clients);
  const captured = Date.now() - 20_000;
  async function push(sequence, offset, raw) {
    const time = new Date(captured + offset);
    const snapshot = sample(sequence, time);
    snapshot.buildings.office.sensors.light.raw = raw;
    await ingest(db, snapshot, time, config);
  }
  await push(0, 0, 280);
  await push(1, 3200, 990);
  assert.equal((await state(db, demoOwner, false)).incidents.length, 0);
  await push(2, 6400, 1023);
  await push(3, 9600, 990);
  assert.equal((await state(db, demoOwner, false)).incidents.length, 0);
  await push(4, 12800, 990);
  await worker.tick();
  let [incident] = (await state(db, demoOwner, false)).incidents;
  const originalRequest = incident.request_id;
  assert.match(incident.owner_question, /extra light source/);
  await worker.tick();
  assert.match(messages.at(-1).body, /Reply ANSWER/);
  assert.equal(await webhook(`ANSWER REQ-${originalRequest} Yes, an extra lamp.`), 204);
  worker = createIntegrationWorker(db, config, clients);
  await worker.tick();
  [incident] = (await state(db, demoOwner, false)).incidents;
  assert.equal(incident.version, 2);
  assert.equal(incident.assessment.outcome, 'inspect');
  assert.equal(incident.owner_question, null);
  await worker.tick();
  assert.match(messages.at(-1).body, new RegExp(incident.request_id));

  const approval = `APPROVE REQ-${incident.request_id}`;
  assert.equal(await webhook(approval, { signatureOK: false }), 401);
  assert.equal(await webhook(`APPROVE REQ-${originalRequest}`), 204);
  assert.equal((await db.query('select id from bc.work_orders')).rows.length, 0);
  assert.equal(await webhook(approval), 204);
  assert.equal(await webhook(approval), 204);
  assert.equal((await db.query('select id from bc.work_orders')).rows.length, 1);
  assert.equal((await db.query("select id from bc.integration_jobs where kind='technician_message'")).rows.length, 1);
  while (await worker.tick()) { /* Drain committed jobs. */ }
  [incident] = (await state(db, demoOwner, false)).incidents;
  assert.equal(incident.work_status, 'contacted');
  const technicianMessages = () => messages.filter(({ recipient }) => recipient === technicianPhone);
  assert.equal(technicianMessages().length, 1);
  assert.ok(technicianMessages()[0].body.includes(`ACCEPT WO-${incident.work_id}`));
  assert.match(technicianMessages()[0].body, /sustained bright light/);

  const accept = `ACCEPT WO-${incident.work_id}`;
  assert.equal(await webhook(accept, { messageId: 'wrong-sender' }), 204);
  assert.equal((await state(db, demoOwner, false)).incidents[0].work_status, 'contacted');
  assert.equal(await webhook(accept, { sender: technicianPhone }), 204);
  assert.equal(await webhook(`REPORT WO-${incident.work_id} Reconnected the lighting wire.`, { sender: technicianPhone }), 204);
  assert.equal((await state(db, demoOwner, false)).incidents[0].status, 'awaiting_verification');
  const recovery = new Date(Date.now() - 3450);
  const normal = sample(5, recovery, { dark: false });
  normal.buildings.office.sensors.light.raw = 891;
  await ingest(db, normal, recovery, config);
  const confirmed = new Date(recovery.valueOf() + 3200);
  const stillNormal = sample(6, confirmed, { dark: false });
  stillNormal.buildings.office.sensors.light.raw = 891;
  await ingest(db, stillNormal, confirmed, config);
  await advanceWork(db, demoOwner, incident.work_id, 'verify', { method: 'sensor' }, false, config);
  assert.equal((await state(db, demoOwner, false)).incidents[0].status, 'resolved');

  const now = new Date();
  await ingest(db, sample(7, now, { dark: false, ir: true }), now, { ...config, investigate: false });
  const ir = (await state(db, demoOwner, false)).incidents.find(({ kind }) => kind === 'ir_alert');
  while (await worker.tick()) { /* Deliver owner updates and the data-center request. */ }
  assert.ok(messages.at(-1).body.includes(`DECLINE REQ-${ir.request_id}`));
  assert.equal(await webhook(`DECLINE REQ-${ir.request_id}`), 204);
  const declined = (await state(db, demoOwner, false)).incidents.find(({ kind }) => kind === 'ir_alert');
  assert.equal(declined.approval, 'declined');
  assert.equal(declined.work_id, null);
  assert.equal(await worker.tick(), false);
  assert.equal(technicianMessages().length, 1);

  // Model a process exit after sending an iMessage, before delivery was recorded.
  await db.query(`update bc.integration_jobs set status='running',lease_until=now()-interval '1 second',
    provider_id=null where kind='technician_message'`);
  assert.equal(await worker.tick(), true);
  assert.equal((await db.query("select status from bc.integration_jobs where kind='technician_message'")).rows[0].status, 'uncertain');
  assert.equal(technicianMessages().length, 1);
});
