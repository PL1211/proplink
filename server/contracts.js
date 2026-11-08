import { z } from 'zod';

export const deviceId = 'unoq-main';
export const buildingId = z.enum(['office', 'data_center']);
export const id = z.uuid();
export const output = z.enum(['led_1', 'led_2', 'led_3', 'fan']);
const commanded = z.object({
  leds: z.tuple([z.boolean(), z.boolean(), z.boolean()]),
  fan: z.enum(['running', 'stopped']),
});
const adcReading = z.object({
  raw: z.number().int().nonnegative(),
  adc_max: z.number().int().positive().max(65535),
  unit: z.literal('adc_counts'),
});
const inAdcRange = ({ raw, adc_max }) => raw <= adc_max;
const light = adcReading.refine(inAdcRange, 'Reading exceeds ADC maximum');
const thermistor = adcReading.extend({ hot: z.boolean() }).refine(inAdcRange, 'Reading exceeds ADC maximum').optional();

export const snapshot = z.object({
  schema_version: z.literal(1),
  device_id: z.literal(deviceId),
  boot_id: z.string().min(1).max(100),
  sequence: z.number().int().min(0).max(2147483647),
  mcu_uptime_ms: z.number().int().nonnegative(),
  captured_at: z.iso.datetime({ offset: true }),
  source: z.enum(['hardware', 'simulated']),
  buildings: z.object({
    office: z.object({ sensors: z.object({ light, thermistor }), commanded }),
    data_center: z.object({
      sensors: z.object({
        thermistor,
        flame_ir: z.object({
          digital_level: z.union([z.literal(0), z.literal(1)]),
          ir_alert: z.boolean(),
          alert_seen_since_last_report: z.boolean(),
        }),
      }),
      commanded,
    }),
  }),
});

export const decision = z.object({ version: z.number().int().positive(), decision: z.enum(['approved', 'declined']) });
export const command = z.object({ building_id: buildingId, output, enabled: z.boolean() });
export const acknowledgment = z.object({
  status: z.enum(['applied', 'rejected']),
  commanded: commanded.optional(),
  error: z.string().trim().min(1).max(300).optional(),
}).refine((value) => value.status === 'applied' ? !!value.commanded : !!value.error,
  'Applied commands require commanded state, rejected commands require a reason');
