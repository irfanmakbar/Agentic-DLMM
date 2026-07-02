import { describe, expect, it } from "vitest";
import { DynamicFeeState, walkSwapExactIn, type BinState, type StaticFeeParams } from "@agentic-dlmm/core";
import { HypotheticalPosition } from "../src/position.js";

const params: StaticFeeParams = {
  baseFactor: 10000,
  baseFeePowerFactor: 0,
  variableFeeControl: 0,
  filterPeriod: 30,
  decayPeriod: 600,
  reductionFactor: 5000,
  maxVolatilityAccumulator: 350000,
  protocolShare: 1000,
};

function poolBins(entries: Array<[number, bigint, bigint]>): Map<number, BinState> {
  const m = new Map<number, BinState>();
  for (const [binId, x, y] of entries) {
    m.set(binId, { binId, x, y, supply: x + y, loAmount: 0n, loAskSide: false });
  }
  return m;
}

describe("HypotheticalPosition", () => {
  it("injects uniform value and computes supply shares", () => {
    const bins = poolBins([
      [-1, 0n, 3_000_000n],
      [0, 500_000n, 500_000n],
      [1, 1_000_000n, 0n],
    ]);
    const pos = new HypotheticalPosition(25); // price ~1 near bin 0
    pos.inject(bins, 0, { valueY: 3_000_000n, binsBelow: 1, binsAbove: 1 });

    // 1M value per bin: below -> Y, above -> X (÷price), active split
    expect(pos.depositY > 0n).toBe(true);
    expect(pos.depositX > 0n).toBe(true);
    // share of bin -1: 1M ours vs 3M pool -> 25%
    expect(pos.shares.get(-1)!).toBeCloseTo(0.25, 6);
    // pool bins were mutated
    expect(bins.get(-1)!.y).toBe(4_000_000n);
  });

  it("fee credit equals share × lpFee", () => {
    const pos = new HypotheticalPosition(25);
    pos.shares.set(0, 0.1);
    pos.creditFee(0, 1_000n, false);
    expect(pos.feesY).toBe(100n);
    pos.creditFee(0, 1_000n, true);
    expect(pos.feesX).toBe(100n);
    // bins we don't own earn us nothing
    pos.creditFee(5, 1_000n, false);
    expect(pos.feesY).toBe(100n);
  });

  it("tracks composition shift through a swap (IL mechanics)", () => {
    const bins = poolBins([[0, 0n, 10_000_000n]]);
    const pos = new HypotheticalPosition(25);
    pos.shares.clear();
    // manually take a 50% share of bin 0
    bins.get(0)!.y += 10_000_000n;
    pos.shares.set(0, 0.5);

    const feeState = new DynamicFeeState(25, params);
    walkSwapExactIn({
      bins,
      binStep: 25,
      startBin: 0,
      swapForY: true,
      amountIn: 5_000_000n,
      feeState,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1000,
    });
    const h = pos.holdings(bins);
    // Y was swapped out, X swapped in: our holdings now contain X
    expect(h.x > 0n).toBe(true);
    expect(h.y < 10_000_000n).toBe(true);
  });

  it("resync preserves holdings across snapshot replacement", () => {
    const bins = poolBins([[0, 2_000_000n, 2_000_000n]]);
    const pos = new HypotheticalPosition(25);
    pos.shares.set(0, 0.25); // we own 500k X + 500k Y

    const before = pos.holdings(bins);
    // fresh snapshot: pool composition changed (someone else added liquidity)
    const fresh = poolBins([[0, 6_000_000n, 6_000_000n]]);
    pos.resync(bins, fresh);
    const after = pos.holdings(fresh);

    // holdings preserved (±rounding)
    expect(Number(after.x)).toBeCloseTo(Number(before.x), -1);
    expect(Number(after.y)).toBeCloseTo(Number(before.y), -1);
    // share diluted: 1M ours vs 12M pool + 1M ours
    expect(pos.shares.get(0)!).toBeCloseTo(1 / 13, 3);
    // fresh bins include our re-added amounts
    expect(fresh.get(0)!.x).toBe(6_500_000n);
  });

  it("structural dilution: bigger pool -> smaller fee share", () => {
    const run = (poolY: bigint) => {
      const bins = poolBins([[0, 0n, poolY]]);
      const pos = new HypotheticalPosition(25);
      pos.inject(bins, 1, { valueY: 1_000_000n, binsBelow: 1, binsAbove: 0 });
      // spec puts 500k in bin 0 (below) and 500k in bin 1 (active); we only care bin 0
      const feeState = new DynamicFeeState(25, params);
      const res = walkSwapExactIn({
        bins,
        binStep: 25,
        startBin: 0,
        swapForY: true,
        amountIn: 400_000n,
        feeState,
        feeOnInput: true,
        supportsLimitOrder: false,
        timestamp: 1000,
      });
      for (const f of res.fills) pos.creditFee(f.binId, f.lpFee, true);
      return pos.feesX;
    };
    const feeSmallPool = run(1_000_000n);
    const feeBigPool = run(100_000_000n);
    expect(feeSmallPool > feeBigPool).toBe(true);
  });
});
