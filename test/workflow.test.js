import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { openDemoDatabase } from '../server/db.js';
import { demoOwner, demoSnapshot } from '../server/demo.js';
import { parseTemperatureCalibration } from '../server/temperature.js';
import { advanceWork, ingest, recordDecision, relearnOfficeLight, state } from '../server/workflow.js';

const otherOwner = '00000000-0000-4000-8000-000000000002';
const outputs = {
  office: { leds: [true, true, true], fan: 'running' },
  data_center: { leds: [true, true, true], fan: 'stopped' },
};

function sample(sequence, timestamp, options = {}) {
  return demoSnapshot({ boot: 'test-boot', sequence, captured: new Date(timestamp), dark: true, ir: false, outputs, ...options });
}

test('office learns stable live light once, ignores short shadows, and queues one alert when covered', async (t) => {
  const db = await openDemoDatabase('memory://');
  t.after(() => db.close());
  await db.query("insert into bc.memberships values ($1,'office')", [demoOwner]);
  const integrations = { monitorIr: false, contacts: { office: {} } };
  const start = Date.now() - 90_000;
  const push = (second, dark, source = 'hardware', clipped = false) => {
    const captured = start + second * 1000;
    const snapshot = { ...sample(second, captured, { dark, ir: true }), source };
    if (clipped) snapshot.buildings.office.sensors.light.raw = 1023;
    return ingest(db, snapshot, new Date(captured + 4200), integrations);
  };
  const office = async () => (await state(db, demoOwner, false)).buildings[0];
  for (let second = 0; second <= 15; second++) await push(second, false, 'simulated');
  assert.equal((await office()).light_min_ratio, null);
  for (const second of [18, 24, 30, 36]) await push(second, false, 'hardware', true);
  assert.equal((await office()).light_baseline_ratio, null);
  for (const second of [42, 48, 54]) await push(second, false);
  assert.equal((await office()).light_baseline_ratio, null);
  await push(60, false);
  const learned = await office();
  assert.ok(Number(learned.light_baseline_ratio) > 0.72);
  assert.ok(Number(learned.light_min_ratio) < 0.5);

  await push(61, true);
  await push(62, true);
  await push(63, false);
  assert.equal((await db.query("select id from bc.incidents where source='hardware'")).rows.length, 0);
  for (const second of [69, 75, 81]) await push(second, true);
  const { incidents } = await state(db, demoOwner, false);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, 'low_light');
  assert.equal((await office()).light_baseline_ratio, learned.light_baseline_ratio);
  assert.equal((await db.query("select id from bc.integration_jobs where kind='owner_approval'")).rows.length, 1);
  await push(87, false, 'hardware', true);
  assert.equal((await db.query("select light_recovered_since from bc.devices where id='unoq-main'")).rows[0].light_recovered_since, null);
  await assert.rejects(relearnOfficeLight(db, demoOwner), { status: 409 });
});

test('one incident and one contact action survive repeated samples and approval; closure requires verification', async (t) => {
  const db = await openDemoDatabase('memory://');
  t.after(() => db.close());
  await db.query("insert into bc.memberships values ($1,'office'),($2,'data_center')", [demoOwner, otherOwner]);
  await db.query("update bc.buildings set light_min_ratio=0.48 where id='office'");
  const now = Date.now();
  await ingest(db, sample(0, now - 8000), new Date(now - 8000));
  await ingest(db, sample(1, now - 4500), new Date(now - 4500));
  assert.deepEqual(await ingest(db, sample(1, now - 4500), new Date(now)), { duplicate: true, current: false });
  await ingest(db, sample(2, now - 4000), new Date(now));
  const ownerState = await state(db, demoOwner, true);
  assert.equal(ownerState.incidents.length, 1);
  assert.equal(ownerState.buildings.length, 1);
  assert.equal((await state(db, otherOwner, true)).incidents.length, 0);
  const incident = ownerState.incidents[0];
  const approve = { version: 1, decision: 'approved' };
  await assert.rejects(recordDecision(db, otherOwner, incident.request_id, approve), { status: 404 });
  await Promise.all([recordDecision(db, demoOwner, incident.request_id, approve), recordDecision(db, demoOwner, incident.request_id, approve)]);
  assert.equal((await db.query('select id from bc.outbound_actions')).rows.length, 1);
  await assert.rejects(recordDecision(db, demoOwner, incident.request_id, { ...approve, decision: 'declined' }), { status: 409 });

  const { work_id: work } = (await state(db, demoOwner, true)).incidents[0];
  await assert.rejects(advanceWork(db, demoOwner, work, 'accept', {}, true), { status: 409 });
  await advanceWork(db, demoOwner, work, 'contact', {}, true);
  await advanceWork(db, demoOwner, work, 'accept', {}, true);
  await advanceWork(db, demoOwner, work, 'report', { notes: 'Repaired a loose connector.' }, true);
  assert.equal((await state(db, demoOwner, true)).incidents[0].status, 'awaiting_verification');
  await assert.rejects(advanceWork(db, demoOwner, work, 'verify', { method: 'sensor' }, true), { status: 409 });
  const recovery = Date.now() - 3500;
  await ingest(db, sample(0, recovery, { boot: 'after-reboot', dark: false }), new Date(recovery + 1));
  await ingest(db, sample(1, recovery + 3200, { boot: 'after-reboot', dark: false }));
  await advanceWork(db, demoOwner, work, 'verify', { method: 'sensor' }, true);
  const resolved = (await state(db, demoOwner, true)).incidents[0];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.verification, 'sensor');
});

test('HTTP validates credentials, separates measured from historical data, and blocks dispatch after a decline', async (t) => {
  const db = await openDemoDatabase('memory://');
  await db.query('insert into bc.memberships select $1,id from bc.buildings', [demoOwner]);
  const token = 'test-device-credential-with-over-32-characters';
  const auth = { getUser: async (value) => ({ data: { user: value === 'owner' ? { id: demoOwner } : null } }) };
  const temperatureCalibration = parseTemperatureCalibration(JSON.stringify({
    office: { adc_max: 1023, points: [{ raw: 500, celsius: 20 }, { raw: 480, celsius: 22 }] },
  }));
  const server = createApp({ db, auth, deviceToken: token, temperatureCalibration }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.close();
  });
  const request = (path, authToken, body) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' },
    method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.deepEqual(await (await request('/photon/webhook', 'wrong')).json(), { enabled: false, deliveryMethod: 'POST' });
  assert.equal((await request('/photon/webhook', 'wrong', {})).status, 503);
  assert.equal((await request('/state', 'wrong')).status, 401);
  assert.equal((await request('/work-orders/00000000-0000-4000-8000-000000000099/progress', 'owner', { action: 'contact' })).status, 404);
  assert.equal((await request('/hardware/telemetry', 'wrong', {})).status, 401);
  assert.equal((await request('/hardware/telemetry', token, {})).status, 422);
  const now = Date.now();
  const historical = { ...sample(0, now - 10000, { ir: true }), source: 'hardware' };
  // Older UNO Q firmware still posts both buildings without thermistor data.
  for (const building of Object.values(historical.buildings)) delete building.sensors.thermistor;
  const oldResponse = await request('/hardware/telemetry', token, historical);
  assert.equal(oldResponse.status, 200);
  assert.equal((await oldResponse.json()).current, false);
  let current = await (await request('/state', 'owner')).json();
  assert.equal(current.buildings[0].connection, 'no_data');
  assert.equal(current.incidents.length, 0);
  const live = { ...sample(1, now, { ir: true }), source: 'hardware' };
  const invalid = structuredClone(live);
  invalid.buildings.office.sensors.thermistor.raw = 1024;
  assert.equal((await request('/hardware/telemetry', token, invalid)).status, 422);
  assert.equal((await request('/hardware/telemetry', token, live)).status, 200);
  current = await (await request('/state', 'owner')).json();
  for (const building of current.buildings) {
    const temperature = { ...live.buildings[building.id].sensors.thermistor, ...(building.id === 'office'
      ? { temperature_c: 20.9, temperature_status: 'estimated' }
      : { temperature_c: null, temperature_status: 'uncalibrated' }) };
    assert.deepEqual(building.reading.sensors.thermistor, temperature);
    const history = await (await request(`/buildings/${building.id}/readings`, 'owner')).json();
    assert.deepEqual(history.map((item) => item.sensors.thermistor), [undefined, temperature]);
  }
  assert.equal(current.incidents[0].kind, 'ir_alert');
  const decision = '/service-requests/' + current.incidents[0].request_id + '/decision';
  assert.equal((await request(decision, 'owner', { version: 1, decision: 'declined' })).status, 200);
  assert.equal((await request(decision, 'owner', { version: 1, decision: 'approved' })).status, 409);
  assert.equal((await db.query('select id from bc.outbound_actions')).rows.length, 0);

  const command = await (await request('/hardware/commands', 'owner', { building_id: 'office', output: 'led_1', enabled: false })).json();
  assert.equal((await (await request('/hardware/commands', token)).json())[0].id, command.id);
  const ack = await request('/hardware/commands/' + command.id + '/ack', token, {
    status: 'applied', commanded: { leds: [false, true, true], fan: 'running' },
  });
  assert.equal((await ack.json()).status, 'applied');
  assert.deepEqual(await (await request('/hardware/commands', token)).json(), []);

  const outsideRange = { ...sample(2, now + 1), source: 'hardware' };
  outsideRange.buildings.office.sensors.thermistor.raw = 540;
  assert.equal((await request('/hardware/telemetry', token, outsideRange)).status, 200);
  const history = await (await request('/buildings/office/readings', 'owner')).json();
  assert.equal(history.at(-1).sensors.thermistor.temperature_c, null);
  assert.equal(history.at(-1).sensors.thermistor.temperature_status, 'out_of_range');
});
