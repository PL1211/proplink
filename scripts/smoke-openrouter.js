import { defaultModel, runNemotron } from '../server/nemotron.js';

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) {
  console.error('Set OPENROUTER_API_KEY in .env before running this smoke test.');
  process.exit(1);
}
const model = process.env.OPENROUTER_MODEL?.trim() || defaultModel;
const at = Date.now();
const samples = [0, 1, 2, 3, 4].map((second) => ({
  captured_at: new Date(at - second * 1000).toISOString(),
  fresh: true,
  commanded: { leds: [true, true, true], fan: 'running' },
  sensors: { light: { raw: 260, adc_max: 1023, unit: 'adc_counts' } },
})).reverse();
const evidence = {
  get_incident: {
    building_id: 'office', kind: 'low_light', source: 'simulated', approval: 'pending',
    fresh: true, lights_expected_on: true, light_min_ratio: 0.45, latest: samples.at(-1),
  },
  get_sensor_history: samples,
  search_verified_repairs: [],
};
try {
  const result = await runNemotron({
    key, model, read: async (name) => evidence[name], onTool: ({ name }) => console.log('Tool:', name),
  });
  console.log(JSON.stringify({ model, ...result }, null, 2));
} catch (error) {
  console.error('OpenRouter smoke test failed:', error.message);
  process.exitCode = 1;
}
