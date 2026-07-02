import { describe, expect, it } from "vitest";
import { geekladEstimate } from "../src/geeklad.js";

describe("geekladEstimate", () => {
  it("projects each window to 24h and takes the minimum", () => {
    const est = geekladEstimate({
      feeTvlRatio: { "30m": 0.01, "1h": 0.015, "24h": 0.6 },
      volume: { "1h": 100, "24h": 1200 },
    });
    expect(est.projections["30m"]).toBeCloseTo(0.48);
    expect(est.projections["1h"]).toBeCloseTo(0.36);
    expect(est.projections["24h"]).toBeCloseTo(0.6);
    expect(est.minProjection).toBeCloseTo(0.36);
    // 100 × 24 = 2400 >= 1200 -> uptrend
    expect(est.volumeUptrend).toBe(true);
  });

  it("flags collapsing volume", () => {
    const est = geekladEstimate({
      feeTvlRatio: { "24h": 0.5 },
      volume: { "1h": 10, "24h": 1000 },
    });
    expect(est.volumeUptrend).toBe(false);
  });

  it("handles missing windows", () => {
    const est = geekladEstimate({ feeTvlRatio: {}, volume: {} });
    expect(est.minProjection).toBeNull();
    expect(est.volumeUptrend).toBeNull();
  });
});
