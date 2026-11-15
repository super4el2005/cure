import normalCdf from "@stdlib/stats-base-dists-normal-cdf";
import normalQuantile from "@stdlib/stats-base-dists-normal-quantile";

// Planning calculations for comparing two proportions in two independent
// equal-sized groups, two-sided, normal approximation without continuity
// correction. These are design-stage estimates: they use no patient data and
// never replace the analysis of an actual fixed sample.
function checkProbability(value: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1)
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  return value;
}
function zQuantile(probability: number) {
  const value = normalQuantile(checkProbability(probability), 0, 1);
  if (!Number.isFinite(value)) throw new Error("ANALYSIS_CALCULATION_FAILED");
  return value;
}
export type PowerConfidence = 90 | 95 | 99;
function alphaOf(confidence: PowerConfidence) {
  return 1 - confidence / 100;
}
// Expected group size per group to detect |p1 - p2| with the requested power.
export function sampleSizePerGroup(
  p1: number,
  p2: number,
  confidence: PowerConfidence,
  power: number,
) {
  checkProbability(p1);
  checkProbability(p2);
  checkProbability(power);
  if (p1 === p2) return null;
  const alpha = alphaOf(confidence);
  const variance = p1 * (1 - p1) + p2 * (1 - p2);
  const n = ((zQuantile(1 - alpha / 2) + zQuantile(power)) ** 2 * variance) / (p1 - p2) ** 2;
  if (!Number.isFinite(n) || n <= 0) throw new Error("ANALYSIS_CALCULATION_FAILED");
  return Math.max(1, Math.ceil(n));
}
// Achieved power of the two-sided z-test with n participants per group.
export function achievedPower(
  p1: number,
  p2: number,
  nPerGroup: number,
  confidence: PowerConfidence,
) {
  checkProbability(p1);
  checkProbability(p2);
  if (!Number.isSafeInteger(nPerGroup) || nPerGroup < 1)
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  if (p1 === p2) return null;
  const alpha = alphaOf(confidence);
  const sigma = Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const z = (Math.abs(p1 - p2) * Math.sqrt(nPerGroup)) / sigma - zQuantile(1 - alpha / 2);
  const power = normalCdf(z, 0, 1);
  if (!Number.isFinite(power)) throw new Error("ANALYSIS_CALCULATION_FAILED");
  return Math.min(1, Math.max(0, power));
}
// Smallest detectable difference |p2 - p1| for the requested power with n per
// group. Solved by monotone bisection over the achieved-power curve.
export function minimumDetectableEffect(
  p1: number,
  nPerGroup: number,
  confidence: PowerConfidence,
  power: number,
) {
  checkProbability(p1);
  checkProbability(power);
  if (!Number.isSafeInteger(nPerGroup) || nPerGroup < 1)
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  const target = (delta: number) => {
    const reached = achievedPower(
      p1,
      Math.min(p1 + delta, 1 - Number.EPSILON),
      nPerGroup,
      confidence,
    );
    if (reached === null) throw new Error("ANALYSIS_CALCULATION_FAILED");
    return reached;
  };
  const upper = Math.min(1 - p1, 1);
  if (upper <= 0) return null;
  if (target(upper) < power) return null;
  let low = 0;
  let high = upper;
  for (let iteration = 0; iteration < 60; iteration++) {
    const mid = (low + high) / 2;
    if (target(mid) >= power) high = mid;
    else low = mid;
  }
  return high;
}
