export const staleMs = 5000;
export const sustainMs = 3000;
export const calibrationMs = 15_000;
export const lightThreshold = (baseline) => baseline * 0.65;

export function officeLightTiming({ ratio, threshold, captured, continuous, previous }) {
  const dark = threshold != null && ratio < threshold;
  const darkSince = dark ? (continuous && previous.dark_since != null ? Number(previous.dark_since) : captured) : null;
  const recoveredSince = threshold != null && !dark
    ? (continuous && previous.light_recovered_since != null ? Number(previous.light_recovered_since) : captured) : null;
  return {
    dark_since: darkSince,
    light_recovered_since: recoveredSince,
    alert: darkSince != null && captured - darkSince >= sustainMs,
    recovered: recoveredSince != null && captured - recoveredSince >= sustainMs,
  };
}

export function learnOfficeBaseline(samples) {
  if (samples.length < 8 || samples.at(-1).captured - samples[0].captured < calibrationMs ||
      samples.some((sample, index) => !sample.lightsOn || (index > 0 && sample.captured - samples[index - 1].captured >= staleMs))) {
    return null;
  }
  const ratios = samples.map(({ ratio }) => ratio).sort((a, b) => a - b);
  const baseline = ratios[Math.floor(ratios.length / 2)];
  if (baseline < 0.06 || ratios.at(-1) - ratios[0] > Math.max(0.02, 0.15 * baseline)) return null;
  return baseline;
}
