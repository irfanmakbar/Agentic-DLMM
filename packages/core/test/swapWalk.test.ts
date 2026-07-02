import { describe, expect, it } from "vitest";
import { qPriceFromId } from "../src/binMath.js";
import { DynamicFeeState, feeFromIncludedAmount } from "../src/dynamicFee.js";
import { walkSwapExactIn } from "../src/swapWalk.js";
import type { BinState, StaticFeeParams } from "../src/types.js";

const params: StaticFeeParams = {
  baseFactor: 10000,
  baseFeePowerFactor: 0,
  variableFeeControl: 0, // fixed fee for deterministic vectors
  filterPeriod: 30,
  decayPeriod: 600,
  reductionFactor: 5000,
  maxVolatilityAccumulator: 350000,
  protocolShare: 1000,
};

function bins(entries: Array<[number, bigint, bigint]>): Map<number, BinState> {
  const m = new Map<number, BinState>();
  for (const [binId, x, y] of entries) {
    m.set(binId, { binId, x, y, supply: x + y, loAmount: 0n, loAskSide: false });
  }
  return m;
}

describe("walkSwapExactIn", () => {
  it("single-bin fill at bin price with fee on input", () => {
    const binStep = 25;
    const state = bins([[0, 0n, 10_000_000n]]); // Y-only liquidity at price 1.0
    const fee = new DynamicFeeState(binStep, params);
    const amountIn = 1_000_000n;
    const res = walkSwapExactIn({
      bins: state,
      binStep,
      startBin: 0,
      swapForY: true,
      amountIn,
      feeState: fee,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1000,
    });
    // base fee = 10000×25×10 = 2.5e6 / 1e9 = 0.25%
    const expectedFee = feeFromIncludedAmount(amountIn, 2_500_000n);
    expect(res.totalTradingFee).toBe(expectedFee);
    expect(res.totalAmountOut).toBe(amountIn - expectedFee); // price 1.0
    expect(res.endBin).toBe(0);
    expect(res.amountLeft).toBe(0n);
    // LP fee = fee − 10% protocol share
    expect(res.totalLpFee).toBe(expectedFee - expectedFee / 10n);
    // bin composition updated: Y decreased by gross out, X increased by net in
    const b = state.get(0)!;
    expect(b.y).toBe(10_000_000n - (amountIn - expectedFee));
    expect(b.x).toBe(amountIn - expectedFee);
  });

  it("walks across bins when liquidity is exhausted", () => {
    const binStep = 100;
    const state = bins([
      [0, 0n, 400_000n],
      [-1, 0n, 400_000n],
      [-2, 0n, 10_000_000n],
    ]);
    const fee = new DynamicFeeState(binStep, params);
    const res = walkSwapExactIn({
      bins: state,
      binStep,
      startBin: 0,
      swapForY: true,
      amountIn: 1_000_000n,
      feeState: fee,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1000,
    });
    expect(res.fills.length).toBe(3);
    expect(res.endBin).toBe(-2);
    expect(res.amountLeft).toBe(0n);
    // bins 0 and -1 fully drained
    expect(state.get(0)!.y).toBe(0n);
    expect(state.get(-1)!.y).toBe(0n);
    // conservation: sum of per-bin gross out === totals
    const sumOut = res.fills.reduce((a, f) => a + f.amountOut, 0n);
    expect(sumOut).toBe(res.totalAmountOut);
  });

  it("fee on output when collect mode requires it", () => {
    const binStep = 25;
    const state = bins([[0, 10_000_000n, 0n]]); // X liquidity, swapping Y->X
    const fee = new DynamicFeeState(binStep, params);
    const amountIn = 1_000_000n;
    const res = walkSwapExactIn({
      bins: state,
      binStep,
      startBin: 0,
      swapForY: false,
      amountIn,
      feeState: fee,
      feeOnInput: false, // e.g. OnlyY mode, swap Y->X takes fee on X out? (fee on output)
      supportsLimitOrder: false,
      timestamp: 1000,
    });
    const grossOut = amountIn; // price 1.0
    const expectedFee = feeFromIncludedAmount(grossOut, 2_500_000n);
    expect(res.totalAmountOut).toBe(grossOut - expectedFee);
    expect(res.totalTradingFee).toBe(expectedFee);
  });

  it("volatile crossing raises the variable fee", () => {
    const binStep = 100;
    const volParams = { ...params, variableFeeControl: 7500 };
    const state = bins([
      [0, 0n, 100_000n],
      [-1, 0n, 100_000n],
      [-2, 0n, 100_000n],
      [-3, 0n, 10_000_000n],
    ]);
    const fee = new DynamicFeeState(binStep, volParams);
    const res = walkSwapExactIn({
      bins: state,
      binStep,
      startBin: 0,
      swapForY: true,
      amountIn: 500_000n,
      feeState: fee,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1000,
    });
    // rates must be non-decreasing as bins are crossed (v_a grows)
    const rates = res.fills.map((f) => f.rate);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]! >= rates[i - 1]!).toBe(true);
    }
    expect(fee.v.volatilityAccumulator).toBe(30000); // 3 bins crossed
  });

  it("limit-order liquidity fills but pays no LP fee", () => {
    const binStep = 25;
    const state = new Map<number, BinState>([
      [0, { binId: 0, x: 0n, y: 500_000n, supply: 500_000n, loAmount: 500_000n, loAskSide: false }],
    ]);
    const fee = new DynamicFeeState(binStep, params);
    const res = walkSwapExactIn({
      bins: state,
      binStep,
      startBin: 0,
      swapForY: true, // Y out; LO on bid side (loAskSide=false) participates
      amountIn: 900_000n,
      feeState: fee,
      feeOnInput: true,
      supportsLimitOrder: true,
      timestamp: 1000,
    });
    const fill = res.fills[0]!;
    expect(fill.mmAmountOut).toBe(500_000n);
    expect(fill.amountOut > 500_000n).toBe(true); // LO topped up the fill
    // LP fee derives only from the MM share of the fill
    expect(fill.lpFee < fill.tradingFee).toBe(true);
  });
});
