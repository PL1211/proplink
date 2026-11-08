import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { acknowledgment, buildingId, command, decision, deviceId, id, snapshot } from './contracts.js';
import { demoOwner } from './demo.js';
import { answerInvestigation } from './nemotron.js';
import { receivePhoton } from './photon.js';
import { addTemperature } from './temperature.js';
import {
  acknowledgeCommand, advanceWork, ingest, pendingCommands, queueCommand, readings,
  recordDecision, relearnOfficeLight, requireCondition, setOfficeLightThresholds, state,
} from './workflow.js';

const scenario = z.enum(['office-dark', 'office-normal', 'ir-alert', 'ir-clear', 'pause', 'resume']);
const notes = z.string().trim().min(1).max(1000);
const lightThresholds = z.strictObject({ dropPercent: z.int().min(1).max(99), risePercent: z.int().min(1).max(100) });
const workUpdate = z.union([
  z.object({ action: z.literal('contact') }),
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('report'), notes }),
  z.object({ action: z.literal('verify'), method: z.literal('manual'), notes }),
  z.object({ action: z.literal('verify'), method: z.literal('sensor') }),
]);

const digest = (value) => createHash('sha256').update(value).digest();
const bearer = (req) => req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];

export function createApp({ db, auth, publicConfig, deviceToken, simulator, temperatureCalibration = {}, integrations = {} }) {
  const app = express();
  const demo = Boolean(simulator);
  const deviceHash = deviceToken ? digest(deviceToken) : null;
  app.disable('x-powered-by');
  if (demo) app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.sendStatus(403);
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site requests are unavailable' });
    }
    next();
  });
  app.get('/api/photon/webhook', (req, res) => res.json({
    enabled: Boolean(integrations.photon), deliveryMethod: 'POST',
  }));
  app.post('/api/photon/webhook',
    (req, res, next) => {
      if (!integrations.photon) return res.status(503).json({ error: 'Photon webhook is disabled.' });
      next();
    },
    express.raw({ type: 'application/json', limit: '128kb', inflate: false }),
    async (req, res) => {
      await receivePhoton(db, integrations, req.body, req.headers);
      res.sendStatus(204);
    });
  app.use('/api', express.json({ limit: '32kb' }));

  const owner = async (req, res, next) => {
    if (demo) {
      req.owner = demoOwner;
    } else {
      const token = bearer(req);
      requireCondition(token, 401, 'Sign in to view BuildingConnect.');
      const { data, error } = await auth.getUser(token);
      requireCondition(!error && data.user, 401, 'Session expired. Sign in again.');
      req.owner = data.user.id;
    }
    next();
  };
  const device = (req, res, next) => {
    const token = bearer(req);
    requireCondition(token && deviceHash && timingSafeEqual(deviceHash, digest(token)), 401, 'Invalid device credential');
    next();
  };

  app.get('/api/config', (req, res) => res.json({ demo, ...publicConfig }));
  app.get('/api/state', owner, async (req, res) => {
    const result = await state(db, req.owner, demo);
    for (const building of result.buildings) {
      if (building.reading) building.reading.sensors = addTemperature(building.reading.sensors, temperatureCalibration[building.id], building.source);
      if (building.id === 'data_center') building.ir_alerts_enabled = demo || integrations.monitorIr !== false;
    }
    res.json(result);
  });
  app.get('/api/activity', owner, async (req, res) => res.json((await state(db, req.owner, demo)).activity));
  app.get('/api/buildings/:id/readings', owner, async (req, res) => {
    const building = buildingId.parse(req.params.id);
    const samples = await readings(db, req.owner, building);
    res.json(samples.map((sample) => ({ ...sample, sensors: addTemperature(sample.sensors, temperatureCalibration[building], sample.source) })));
  });
  app.get('/api/incidents/:id', owner, async (req, res) => {
    const incidentId = id.parse(req.params.id);
    const { incidents } = await state(db, req.owner, demo);
    const incident = incidents.find((item) => item.id === incidentId);
    requireCondition(incident, 404, 'Incident not found');
    res.json(incident);
  });
  app.post('/api/service-requests/:id/decision', owner, async (req, res) => {
    const result = await recordDecision(db, req.owner, id.parse(req.params.id), decision.parse(req.body), integrations);
    res.json({ id: result.id, status: result.status, version: result.version });
  });
  app.post('/api/work-orders/:id/progress', owner, async (req, res) => {
    const input = workUpdate.parse(req.body);
    res.json(await advanceWork(db, req.owner, id.parse(req.params.id), input.action, input, demo, integrations));
  });
  app.post('/api/service-requests/:id/answer', owner, async (req, res) => {
    const requestId = id.parse(req.params.id);
    const input = z.object({ reply: notes }).parse(req.body);
    await db.transaction((tx) => answerInvestigation(tx, req.owner, requestId, input.reply));
    res.json({ ok: true });
  });
  app.post('/api/hardware/telemetry', device, async (req, res) => {
    const input = snapshot.parse(req.body);
    requireCondition(input.source === (demo ? 'simulated' : 'hardware'), 422, 'Unexpected telemetry source for this environment');
    res.json(await ingest(db, input, new Date(), integrations));
  });
  if (!demo) app.post('/api/buildings/office/light/relearn', owner, async (req, res) => {
    await relearnOfficeLight(db, req.owner);
    res.json({ ok: true });
  });
  app.post('/api/buildings/office/light/thresholds', owner, async (req, res) => {
    await setOfficeLightThresholds(db, req.owner, lightThresholds.parse(req.body));
    res.json({ ok: true });
  });
  app.get('/api/hardware/commands', device, async (req, res) => res.json(await pendingCommands(db, deviceId)));
  app.post('/api/hardware/commands', owner, async (req, res) => {
    res.status(201).json(await queueCommand(db, req.owner, command.parse(req.body)));
  });
  app.post('/api/hardware/commands/:id/ack', device, async (req, res) => {
    res.json(await acknowledgeCommand(db, deviceId, id.parse(req.params.id), acknowledgment.parse(req.body)));
  });
  if (demo) app.post('/api/demo/scenario', owner, async (req, res) => {
    await simulator.apply(scenario.parse(req.body?.scenario));
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return res.status(422).json({ error: [issue.path.join('.'), issue.message].filter(Boolean).join(' — ') });
    }
    const status = error.status ?? 500;
    if (status >= 500) console.error(req.method, req.path, error.code ?? error.message);
    res.status(status).json({ error: status >= 500 ? 'The server could not complete the request.' : error.message });
  });
  return app;
}
