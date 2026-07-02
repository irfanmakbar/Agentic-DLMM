import { describe, expect, it } from "vitest";
import { DynamicFeeState, totalFeeRate, type StaticFeeParams } from "@agentic-dlmm/core";
import { feeResidualReport, type ResidualSwap } from "../src/calibration/feeResiduals.js";

const params: StaticFeeParams = {
  baseFactor: 10000,
  baseFeePowerFactor: 0,
  variableFeeControl: 7500,
  filterPeriod: 30,
  decayPeriod: 600,
  reductionFactor: 5000,
  maxVolatilityAccumulator: 350000,
  protocolShare: 1000,
};
const BIN_STEP = 10;

/** generate a synthetic swap stream with fee_bps produced by the same state machine */
function synthSwaps(n: number, endBinSemantics: boolean): ResidualSwap[] {
  const state = new DynamicFeeState(BIN_STEP, params);
  const swaps: ResidualSwap[] = [];
  let bin = 100;
  let ts = 10_000;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < n; i++) {
    ts += Math.floor(rnd() * 90); // 0-90s gaps (some decay, some not)
    const drift = Math.floor(rnd() * 7) - 3;
    const startBin = bin;
    const endBin = bin + drift;
    state.updateReferences(startBin, ts);
    const rateAt = (b: number) => {
      const deltaId = Math.abs(state.v.indexReference - b);
      const vAcc = Math.min(state.v.volatilityReference + deltaId * 10_000, params.maxVolatilityAccumulator);
      return Number(totalFeeRate(BIN_STEP, params, vAcc));
    };
    const feeBps = endBinSemantics ? rateAt(endBin) : rateAt(startBin);
    state.updateVolatilityAccumulator(endBin);
    swaps.push({ sig: `sig${i}`, startBin, endBin, ts, feeBps });
    bin = endBin;
  }
  return swaps;
}

describe("feeResidualReport", () => {
  it("perfectly matches a stream generated with end-bin semantics", () => {
    const swaps = synthSwaps(500, true);
    const report = feeResidualReport(BIN_STEP, params, swaps, {
      volatilityAccumulator: 0,
      volatilityReference: 0,
      indexReference: 100,
      lastUpdateTimestamp: 10_000,
    });
    expect(report.endBin.n).toBe(500);
    expect(report.endBin.exact).toBe(500);
    expect(report.endBin.max).toBe(0);
    // start-bin hypothesis must NOT fit perfectly (they differ on moving swaps)
    expect(report.startBin.exact).toBeLessThan(500);
  });

  it("cold start skips swaps until a decay gap, then is exact", () => {
    const swaps = synthSwaps(200, true);
    // widen one gap beyond decayPeriod so warm-up completes there
    const idx = 60;
    const shift = params.decayPeriod + 100;
    for (let i = idx; i < swaps.length; i++) swaps[i] = { ...swaps[i]!, ts: swaps[i]!.ts + shift };
    // regenerate observed rates for the shifted stream (same generator logic)
    const state = new DynamicFeeState(BIN_STEP, params);
    for (const s of swaps) {
      state.updateReferences(s.startBin, s.ts);
      const deltaId = Math.abs(state.v.indexReference - s.endBin);
      const vAcc = Math.min(state.v.volatilityReference + deltaId * 10_000, params.maxVolatilityAccumulator);
      s.feeBps = Number(totalFeeRate(BIN_STEP, params, vAcc));
      state.updateVolatilityAccumulator(s.endBin);
    }

    const report = feeResidualReport(BIN_STEP, params, swaps); // no seed
    expect(report.seededFrom).toBe("decay-gap");
    expect(report.warmupSkipped).toBeGreaterThan(0);
    expect(report.endBin.exact).toBe(report.endBin.n);
  });
});
