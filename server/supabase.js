import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { openSupabaseDatabase } from './db.js';
import { integrationConfig } from './integration-config.js';

export function createSupabaseRuntime(env = process.env) {
  const { DATABASE_URL, DATABASE_CA_CERT, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEVICE_TOKEN } = env;
  if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_') ||
      (DEVICE_TOKEN?.length ?? 0) < 32) {
    throw new Error('Supabase mode requires DATABASE_URL, SUPABASE_URL, a publishable key, and a device token of at least 32 characters.');
  }
  const integrations = integrationConfig(env);
  const db = openSupabaseDatabase(DATABASE_URL, DATABASE_CA_CERT);
  const { auth } = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const app = createApp({
    db, auth, deviceToken: DEVICE_TOKEN, temperatureCalibration: integrations.temperatureCalibration, integrations,
    publicConfig: { url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY },
  });
  return { app, db };
}
