import { describe, expect, it } from "@rstest/core";

import {
  achievedPower,
  minimumDetectableEffect,
  sampleSizePerGroup,
} from "@/src/lib/power-analysis";

describe("power analysis for two proportions", () => {
  it("computes the textbook sample size per group", () => {
    // (z(0.975) + z(0.8))^2 * (0.16 + 0.09) / 0.01 = 196.2 -> 197
    expect(sampleSizePerGroup(0.2, 0.1, 95, 0.8)).toBe(197);
    // (z(0.975) + z(0.8))^2 * (0.25 + 0.16) / 0.09 = 35.76 -> 36
    expect(sampleSizePerGroup(0.5, 0.2, 95, 0.8)).toBe(36);
    expect(sampleSizePerGroup(0.1, 0.2, 95, 0.8)).toBe(197);
    expect(sampleSizePerGroup(0.2, 0.1, 99, 0.9)).toBeGreaterThan(
      sampleSizePerGroup(0.2, 0.1, 95, 0.8)!,
    );
    expect(sampleSizePerGroup(0.2, 0.2, 95, 0.8)).toBeNull();
  });
  it("recovers the requested power at the computed sample size", () => {
    const n = sampleSizePerGroup(0.2, 0.1, 95, 0.8)!;
    const power = achievedPower(0.2, 0.1, n, 95)!;
    expect(power).toBeGreaterThanOrEqual(0.79);
    expect(power).toBeLessThan(0.95);
    expect(achievedPower(0.2, 0.1, Math.floor(n / 2), 95)!).toBeLessThan(power);
    expect(achievedPower(0.2, 0.2, n, 95)).toBeNull();
  });
  it("solves the minimum detectable effect consistently", () => {
    const n = sampleSizePerGroup(0.2, 0.1, 95, 0.8)!;
    const mde = minimumDetectableEffect(0.2, n, 95, 0.8)!;
    expect(mde).toBeGreaterThan(0.11);
    expect(mde).toBeLessThan(0.14);
    expect(achievedPower(0.2, 0.2 + mde, n, 95)!).toBeGreaterThanOrEqual(0.8);
    expect(minimumDetectableEffect(0.95, 5, 95, 0.999)).toBeNull();
  });
  it("rejects invalid input deterministically", () => {
    for (const call of [
      () => sampleSizePerGroup(0, 0.1, 95, 0.8),
      () => sampleSizePerGroup(1, 0.1, 95, 0.8),
      () => sampleSizePerGroup(Number.NaN, 0.1, 95, 0.8),
      () => sampleSizePerGroup(0.2, 0.1, 95, 1),
      () => achievedPower(0.2, 0.1, 0, 95),
      () => achievedPower(0.2, 0.1, 3.5, 95),
      () => minimumDetectableEffect(0.2, 0, 95, 0.8),
    ])
      expect(call).toThrow("ANALYSIS_CALCULATION_FAILED");
  });
});
