import { z } from 'zod';
import { buildingId } from './contracts.js';
import { defaultModel } from './nemotron.js';
import { parseTemperatureCalibration } from './temperature.js';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const contacts = z.partialRecord(buildingId, z.strictObject({
  ownerUserId: z.uuid(),
  ownerPhone: phone,
  technicianPhone: phone,
}).refine(({ ownerPhone, technicianPhone }) => ownerPhone !== technicianPhone));

function required(env, name, alias) {
  const value = env[name]?.trim() || (alias && env[alias]?.trim());
  if (!value) throw new Error(`Set ${name} to enable the integration.`);
  return value;
}

export function integrationConfig(env) {
  const config = {
    temperatureCalibration: parseTemperatureCalibration(env.THERMISTOR_CALIBRATION),
    monitorIr: env.MONITOR_DATA_CENTER_IR === 'true',
  };
  if (env.OPENROUTER_API_KEY?.trim()) {
    config.openrouter = { key: env.OPENROUTER_API_KEY.trim(), model: env.OPENROUTER_MODEL?.trim() || defaultModel };
    config.investigate = true;
  }
  if (env.PHOTON_ENABLED !== 'true') return config;
  const rawContacts = required(env, 'PHOTON_CONTACTS');
  let value;
  try { value = JSON.parse(rawContacts); } catch { throw new Error('PHOTON_CONTACTS must contain valid JSON.'); }
  const parsed = contacts.safeParse(value);
  if (!parsed.success || !Object.keys(parsed.data).length) {
    throw new Error('PHOTON_CONTACTS must map building IDs to an owner UUID and distinct E.164 owner and technician numbers.');
  }
  config.contacts = parsed.data;
  config.photon = {
    projectId: required(env, 'PHOTON_PROJECT_ID', 'SPECTRUM_PROJECT_ID'),
    projectSecret: required(env, 'PHOTON_PROJECT_SECRET', 'SPECTRUM_PROJECT_SECRET'),
    webhookSecret: required(env, 'PHOTON_WEBHOOK_SECRET', 'SPECTRUM_WEBHOOK_SECRET'),
    line: phone.optional().parse(env.PHOTON_LINE_NUMBER?.trim() || undefined),
  };
  if (Object.values(config.contacts).some((contact) =>
    [contact.ownerPhone, contact.technicianPhone].includes(config.photon.line))) {
    throw new Error('The Photon line must differ from each recipient number.');
  }
  return config;
}
