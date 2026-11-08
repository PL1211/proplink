export const staleMs = 15_000;
export const officeSampleGapMs = 8000;
export const sustainMs = 3000;
export const calibrationMs = 15_000;
export const defaultLightDropPercent = 35;
export const defaultLightRisePercent = 10;
export const lightThreshold = (baseline, dropPercent = defaultLightDropPercent) => baseline * (1 - dropPercent / 100);

export function lightUpperThreshold(baseline, adcMax, risePercent = defaultLightRisePercent) {
  if (baseline == null) return null;
  const limit = baseline * (1 + risePercent / 100);
  return limit < (adcMax - 1) / adcMax ? limit : null;
}

function lightDirection(ratio, threshold, upperThreshold) {
  if (ratio < threshold) return 'low';
  return upperThreshold != null && ratio > upperThreshold ? 'high' : null;
}

export function officeLightTiming({ ratio, threshold, upperThreshold, captured, continuous, previous, previousRatio }) {
  const usable = threshold != null && ratio < 1;
  const direction = usable ? lightDirection(ratio, threshold, upperThreshold) : null;
  const sameDirection = continuous && previousRatio != null && previousRatio < 1 &&
    direction === lightDirection(previousRatio, threshold, upperThreshold);
  const outOfRangeSince = direction ? (sameDirection && previous.dark_since != null ? Number(previous.dark_since) : captured) : null;
  const recoveredSince = usable && !direction
    ? (continuous && previous.light_recovered_since != null ? Number(previous.light_recovered_since) : captured) : null;
  return {
    direction,
    dark_since: outOfRangeSince,
    light_recovered_since: recoveredSince,
    alert: outOfRangeSince != null && captured - outOfRangeSince >= sustainMs,
    recovered: recoveredSince != null && captured - recoveredSince >= sustainMs,
  };
}

export function learnOfficeBaseline(samples) {
  if (samples.length < 4 || samples.at(-1).captured - samples[0].captured < calibrationMs ||
      samples.some((sample, index) => !sample.lightsOn || sample.ratio >= 1 ||
        (index > 0 && sample.captured - samples[index - 1].captured >= officeSampleGapMs))) {
    return null;
  }
  const ratios = samples.map(({ ratio }) => ratio).sort((a, b) => a - b);
  const baseline = ratios[Math.floor(ratios.length / 2)];
  if (baseline < 0.06 || ratios.at(-1) - ratios[0] > Math.max(0.02, 0.15 * baseline)) return null;
  return baseline;
}
