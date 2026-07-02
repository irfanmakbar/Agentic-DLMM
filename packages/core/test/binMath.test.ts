import { describe, expect, it } from "vitest";
import {
  ONE_Q64,
  binPriceRaw,
  binPriceUi,
  getAmountIn,
  getAmountOut,
  mulShr,
  qPriceFromId,
  shlDiv,
} from "../src/binMath.js";

describe("qPriceFromId", () => {
  it("bin 0 is exactly 1.0", () => {
    expect(qPriceFromId(0, 25)).toBe(ONE_Q64);
  });

  it("matches float math for positive and negative ids", () => {
    for (const [binId, binStep] of [
      [1, 25],
      [100, 25],
      [-100, 25],
      [8388, 10],
      [-6380, 4],
      [500, 100],
      [-500, 100],
    ] as const) {
      const q = qPriceFromId(binId, binStep);
      const approx = Number(q) / 2 ** 64;
      const expected = binPriceRaw(binId, binStep);
      expect(Math.abs(approx / expected - 1)).toBeLessThan(1e-9);
    }
  });

  it("ui price adjusts for decimals", () => {
    // bin 0, X has 6 decimals, Y has 9: ui price = 10^(6-9) = 1e-3
    expect(binPriceUi(0, 25, 6, 9)).toBeCloseTo(1e-3, 12);
  });
});

describe("amount conversions", () => {
  const q = qPriceFromId(0, 25); // price = 1.0
  it("swapForY: out = in × P", () => {
    expect(getAmountOut(q, 1_000_000n, true)).toBe(1_000_000n);
  });
  it("swapForX: out = in / P", () => {
    expect(getAmountOut(q, 1_000_000n, false)).toBe(1_000_000n);
  });
  it("getAmountIn roundUp inverts getAmountOut", () => {
    const q2 = qPriceFromId(1234, 25);
    const out = getAmountOut(q2, 5_000_000n, true);
    const backIn = getAmountIn(q2, out, true, true);
    expect(backIn <= 5_000_000n).toBe(true);
    // walking the input back through the price recovers at least `out`
    expect(getAmountOut(q2, backIn, true) >= out - 1n).toBe(true);
  });
  it("mulShr/shlDiv rounding", () => {
    expect(mulShr(3n, ONE_Q64 / 2n, false)).toBe(1n);
    expect(mulShr(3n, ONE_Q64 / 2n, true)).toBe(2n);
    expect(shlDiv(1n, 3n * ONE_Q64, false)).toBe(0n);
    expect(shlDiv(1n, 3n * ONE_Q64, true)).toBe(1n);
  });
});
