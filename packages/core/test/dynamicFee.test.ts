import { describe, expect, it } from "vitest";
import {
  DynamicFeeState,
  baseFeeRate,
  feeFromIncludedAmount,
  feeOnExcludedAmount,
  protocolFeeOf,
  totalFeeRate,
  variableFeeRate,
} from "../src/dynamicFee.js";
import type { StaticFeeParams } from "../src/types.js";

/** SOL-USDC bin step 4 pool style params (observed live) */
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

describe("fee rate formulas (docs §4.2 exact)", () => {
  it("base fee = baseFactor × binStep × 10 × 10^power", () => {
    // 10000 × 4 × 10 = 400_000 (1e9 precision) = 0.04%
    expect(baseFeeRate(4, params)).toBe(400_000n);
    // memecoin preset: baseFactor 30000, binStep 100 -> 3% base fee
    expect(baseFeeRate(100, { ...params, baseFactor: 30000 })).toBe(30_000_000n);
    // power factor multiplies by 10^power
    expect(baseFeeRate(4, { ...params, baseFeePowerFactor: 1 })).toBe(4_000_000n);
  });

  it("variable fee = ceil(vfc × (v_a × binStep)² / 1e11)", () => {
    // v_a=10000, binStep=4: (40000)² × 7500 = 1.2e13 -> /1e11 = 120
    expect(variableFeeRate(4, params, 10_000)).toBe(120n);
    // ceil behaviour: value just above an integer boundary rounds up
    // v_a=101, binStep=4: (404)² × 7500 = 1_224_120_000 -> /1e11 = 0.0122 -> ceil = 1
    expect(variableFeeRate(4, params, 101)).toBe(1n);
    // vfc = 0 disables
    expect(variableFeeRate(4, { ...params, variableFeeControl: 0 }, 100_000)).toBe(0n);
  });

  it("total fee capped at 10%", () => {
    const extreme: StaticFeeParams = { ...params, baseFactor: 50000, variableFeeControl: 7_500_000 };
    expect(totalFeeRate(100, extreme, 350_000)).toBe(100_000_000n);
  });

  it("fee application matches SDK computeFeeFromAmount / computeFee", () => {
    const rate = 30_000_000n; // 3%
    // included: ceil(1e9 × 0.03) = 3e7
    expect(feeFromIncludedAmount(1_000_000_000n, rate)).toBe(30_000_000n);
    // excluded: ceil(amount × rate / (prec - rate))
    expect(feeOnExcludedAmount(970_000_000n, rate)).toBe(30_000_000n);
    // protocol cut: floor(fee × 1000/10000)
    expect(protocolFeeOf(30_000_000n, params)).toBe(3_000_000n);
  });
});

describe("volatility state machine", () => {
  it("accumulates bin crossings within filter period", () => {
    const s = new DynamicFeeState(4, params);
    s.updateReferences(100, 1000);
    s.updateVolatilityAccumulator(103); // |100-103| × 10000 = 30000
    expect(s.v.volatilityAccumulator).toBe(30000);
    // next swap 10s later (< filterPeriod): reference unchanged
    s.updateReferences(103, 1010);
    expect(s.v.indexReference).toBe(100);
    s.updateVolatilityAccumulator(105);
    expect(s.v.volatilityAccumulator).toBe(50000);
  });

  it("decays after filter period, resets after decay period", () => {
    const s = new DynamicFeeState(4, params);
    s.updateReferences(100, 1000);
    s.updateVolatilityAccumulator(110); // v_a = 100000
    // 60s later (filter < 60 < decay): v_r = v_a × 0.5
    s.updateReferences(110, 1060);
    expect(s.v.volatilityReference).toBe(50000);
    expect(s.v.indexReference).toBe(110);
    s.updateVolatilityAccumulator(110);
    expect(s.v.volatilityAccumulator).toBe(50000);
    // 700s later (> decayPeriod): v_r resets to 0
    s.updateReferences(110, 1760);
    expect(s.v.volatilityReference).toBe(0);
  });

  it("caps at maxVolatilityAccumulator", () => {
    const s = new DynamicFeeState(4, params);
    s.updateReferences(0, 1000);
    s.updateVolatilityAccumulator(1000);
    expect(s.v.volatilityAccumulator).toBe(350000);
  });
});
