import { z } from 'zod';

const point = z.object({ raw: z.number().int().positive(), celsius: z.number().gt(-273.15) });
const adcMax = z.number().int().positive().max(65535);
const measuredProfile = z.strictObject({ adc_max: adcMax, points: z.array(point).min(2) })
  .transform(({ adc_max, points }) => ({ adc_max, points: [...points].sort((a, b) => a.raw - b.raw) }))
  .refine(({ adc_max, points }) => {
    const direction = Math.sign(points[1].celsius - points[0].celsius);
    return direction !== 0 && points.every((p, i) => p.raw < adc_max && (i === 0 ||
      (p.raw > points[i - 1].raw && Math.sign(p.celsius - points[i - 1].celsius) === direction)));
  }, 'Calibration points must have distinct in-range counts and consistently rising or falling temperatures');
const roomProfile = z.strictObject({ adc_max: adcMax, reference: point })
  .refine(({ adc_max, reference }) => reference.raw < adc_max, 'The reference count must be below the ADC maximum');
const profile = z.union([measuredProfile, roomProfile]);
const profiles = z.strictObject({ office: profile.optional(), data_center: profile.optional() });

export function parseTemperatureCalibration(value) {
  return value ? profiles.parse(JSON.parse(value)) : {};
}

// These points define the simulator's synthetic signal only.
const demoProfile = { adc_max: 1023, points: [{ raw: 400, celsius: 15 }, { raw: 650, celsius: 40 }] };

function estimateFromRoomReference(raw, { adc_max, reference }) {
  if (raw <= 0 || raw >= adc_max) return null;
  // Approximate the KY-028 as a ratiometric divider with the NTC on the ground side.
  // The fixed resistor cancels when comparing its resistance ratio to the room reference.
  const resistanceRatio = (raw / (adc_max - raw)) / (reference.raw / (adc_max - reference.raw));
  const roomKelvin = reference.celsius + 273.15;
  const nominalBeta = 3950;
  const kelvin = 1 / (1 / roomKelvin + Math.log(resistanceRatio) / nominalBeta);
  const celsius = kelvin - 273.15;
  // Limit the single-reference model to temperatures near the reference.
  return Math.abs(celsius - reference.celsius) <= 10 ? celsius : null;
}

export function addTemperature(sensors, calibration, source) {
  const thermistor = sensors.thermistor;
  if (!thermistor) return sensors;
  const active = source === 'simulated' ? demoProfile : calibration;
  let temperature_c = null;
  let temperature_status = 'uncalibrated';
  if (active?.adc_max === thermistor.adc_max && active.reference) {
    temperature_c = estimateFromRoomReference(thermistor.raw, active);
    temperature_status = temperature_c == null ? 'out_of_range' : 'room_estimate';
  } else if (active?.adc_max === thermistor.adc_max) {
    const points = active.points;
    const { raw } = thermistor;
    temperature_status = 'out_of_range';
    if (raw >= points[0].raw && raw <= points.at(-1).raw) {
      const upper = points.findIndex((point, i) => i > 0 && raw <= point.raw);
      const a = points[upper - 1];
      const b = points[upper];
      // Interpolate only between measured points. Thermistor response is nonlinear.
      temperature_c = a.celsius + (raw - a.raw) / (b.raw - a.raw) * (b.celsius - a.celsius);
      temperature_status = 'estimated';
    }
  }
  return { ...sensors, thermistor: { ...thermistor, temperature_c, temperature_status } };
}
