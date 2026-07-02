import { describe, expect, it } from "vitest";
import { binPriceRaw } from "@agentic-dlmm/core";
import { strategyDeposits } from "../src/calibration/depositShape.js";

const BIN_STEP = 100;

describe("strategyDeposits (SDK toAmountsBothSideByStrategy mirror)", () => {
  it("bidAsk with range fully below active: Y-only, descending weights", () => {
    // real case AV3Qz…: active -478, range [-548, -479], 1e9 Y deposited
    const out = strategyDeposits("bidAsk", -548, -479, -478, BIN_STEP, 0n, 1_000_000_000n, 0n, 0n);
    expect(out).toHaveLength(70);
    expect(out.every((d) => d.x === 0n)).toBe(true);
    // weight(b) = maxBin - b + 1 -> bin -548 gets 70 units, bin -479 gets 1
    const totalWeight = (70 * 71) / 2;
    const at = (binId: number) => out.find((d) => d.binId === binId)!;
    expect(at(-548).y).toBe(BigInt(Math.floor((1e9 * 70) / totalWeight)));
    expect(at(-479).y).toBe(BigInt(Math.floor((1e9 * 1) / totalWeight)));
    // dust from floors only
    const sum = out.reduce((a, d) => a + d.y, 0n);
    expect(1_000_000_000n - sum < 100n).toBe(true);
  });

  it("spot in-range: uniform Y through active, X above ∝ 1/price", () => {
    const out = strategyDeposits("spot", -2, 2, 0, BIN_STEP, 1_000_000n, 900_000n, 0n, 0n);
    const at = (binId: number) => out.find((d) => d.binId === binId)!;
    // bid side = bins [-2..0] uniform thirds of Y
    expect(at(-2).y).toBe(300_000n);
    expect(at(-1).y).toBe(300_000n);
    expect(at(0).y).toBe(300_000n);
    expect(at(0).x).toBe(0n); // spot puts no X in the active bin when Y > 0
    // ask side = bins [1..2]: amount ∝ 1/price -> lower bin gets slightly more
    expect(at(1).x > at(2).x).toBe(true);
    const totalX = at(1).x + at(2).x;
    expect(1_000_000n - totalX < 10n).toBe(true);
  });

  it("curve in-range concentrates near the active bin", () => {
    const out = strategyDeposits("curve", -3, 3, 0, BIN_STEP, 1_000_000n, 1_000_000n, 0n, 0n);
    const at = (binId: number) => out.find((d) => d.binId === binId)!;
    // bid side ascending toward active: |-1| > |-3|
    expect(at(-1).y > at(-3).y).toBe(true);
    // ask side descending away from active: 1 > 3
    expect(at(1).x > at(3).x).toBe(true);
  });

  it("single-sided X (ask) deposit keeps active bin on the X ladder", () => {
    const out = strategyDeposits("bidAsk", 0, 5, 0, BIN_STEP, 600_000n, 0n, 0n, 0n);
    // no Y anywhere; X spread over [0..5] ascending (edge-heavy)
    expect(out.every((d) => d.y === 0n)).toBe(true);
    const at = (binId: number) => out.find((d) => d.binId === binId)!;
    expect(at(5).x > at(0).x).toBe(true);
  });

  it("both-side out-of-range above: everything lands as X ∝ weight/price", () => {
    const out = strategyDeposits("spot", 10, 12, 5, BIN_STEP, 300_000n, 999n, 0n, 0n);
    expect(out.every((d) => d.y === 0n)).toBe(true);
    const total = out.reduce((a, d) => a + Number(d.x) * binPriceRaw(d.binId, BIN_STEP), 0);
    // X value ≈ amountX × price near those bins; just check conservation of X units
    const sumX = out.reduce((a, d) => a + d.x, 0n);
    expect(300_000n - sumX < 10n).toBe(true);
    expect(total > 0).toBe(true);
  });
});
