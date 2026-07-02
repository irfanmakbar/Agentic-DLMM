// Parity between @agentic-dlmm/core math and the pinned SDK implementation.
// Pure functions only — no network.
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  DynamicFeeState,
  qPriceFromId,
  totalFeeRate,
  walkSwapExactIn,
  type BinState,
  type StaticFeeParams,
  type VolatilityState,
} from "@agentic-dlmm/core";
import { dlmm } from "../src/sdk.js";

const staticParams: StaticFeeParams = {
  baseFactor: 30000,
  baseFeePowerFactor: 0,
  variableFeeControl: 7500,
  filterPeriod: 300,
  decayPeriod: 1200,
  reductionFactor: 5000,
  maxVolatilityAccumulator: 150000,
  protocolShare: 1000,
};

// SDK sParameter shape (full on-chain struct; extra fields unused by fee math)
const sParameter = {
  baseFactor: staticParams.baseFactor,
  baseFeePowerFactor: staticParams.baseFeePowerFactor,
  variableFeeControl: staticParams.variableFeeControl,
  filterPeriod: staticParams.filterPeriod,
  decayPeriod: staticParams.decayPeriod,
  reductionFactor: staticParams.reductionFactor,
  maxVolatilityAccumulator: staticParams.maxVolatilityAccumulator,
  protocolShare: staticParams.protocolShare,
  minBinId: -443636,
  maxBinId: 443636,
  functionType: 0,
  collectFeeMode: 0,
  padding: [] as number[],
};

describe("price ladder parity", () => {
  it("qPriceFromId matches SDK getQPriceFromId", () => {
    for (const [binId, binStep] of [
      [0, 25],
      [1, 25],
      [-1, 25],
      [777, 10],
      [-777, 10],
      [-6380, 4],
      [1200, 100],
      [-1200, 100],
    ] as const) {
      const ours = qPriceFromId(binId, binStep);
      const sdk = dlmm.getQPriceFromId(new BN(binId), new BN(binStep));
      const diff = ours - BigInt(sdk.toString());
      // allow ±1 ulp from rounding order differences
      expect(Math.abs(Number(diff))).toBeLessThanOrEqual(1);
    }
  });
});

describe("fee rate parity", () => {
  it("totalFeeRate matches SDK getTotalFee across volatility levels", () => {
    for (const vAcc of [0, 1, 999, 10_000, 55_555, 150_000]) {
      const vParameter = {
        volatilityAccumulator: vAcc,
        volatilityReference: 0,
        indexReference: 0,
        padding: [] as number[],
        lastUpdateTimestamp: new BN(0),
        padding1: [] as number[],
      };
      const ours = totalFeeRate(100, staticParams, vAcc);
      const sdk = dlmm.getTotalFee(100, sParameter, vParameter);
      expect(ours.toString()).toBe(sdk.toString());
    }
  });
});

describe("single-bin swap parity", () => {
  function sdkBin(x: bigint, y: bigint, qPrice: bigint) {
    return {
      amountX: new BN(x.toString()),
      amountY: new BN(y.toString()),
      price: new BN(qPrice.toString()),
      liquiditySupply: new BN((x + y).toString()),
      rewardPerTokenStored: [],
      feeAmountXPerTokenStored: new BN(0),
      feeAmountYPerTokenStored: new BN(0),
      amountXIn: new BN(0),
      amountYIn: new BN(0),
      openOrderAmount: new BN(0),
      processedOrderRemainingAmount: new BN(0),
      fulfilledOrderAmountX: new BN(0),
      fulfilledOrderAmountY: new BN(0),
      orderAge: 0,
      limitOrderFeeAskSide: new BN(0),
      limitOrderFeeBidSide: new BN(0),
      limitOrderAskSide: false,
    };
  }

  it("matches SDK swapExactInQuoteAtBin (fee on input, partial fill of bin)", () => {
    const binStep = 100;
    const binId = -50;
    const qPrice = qPriceFromId(binId, binStep);
    const y = 50_000_000_000n;
    const amountIn = 1_000_000_000n;
    // SDK quote uses the given v_a as-is; our walk recomputes v_a from the
    // references, so encode the same volatility via volatilityReference.
    const vState: VolatilityState = {
      volatilityAccumulator: 42_000,
      volatilityReference: 42_000,
      indexReference: binId,
      lastUpdateTimestamp: 1_000,
    };

    // ours
    const bins = new Map<number, BinState>([
      [binId, { binId, x: 0n, y, supply: y, loAmount: 0n, loAskSide: false }],
    ]);
    const feeState = new DynamicFeeState(binStep, staticParams, vState);
    const ours = walkSwapExactIn({
      bins,
      binStep,
      startBin: binId,
      swapForY: true,
      amountIn,
      feeState,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1_000, // elapsed 0 < filterPeriod: no reference change
    });

    // SDK
    const vParameter = {
      volatilityAccumulator: 42_000,
      volatilityReference: 42_000,
      indexReference: binId,
      padding: [] as number[],
      lastUpdateTimestamp: new BN(1_000),
      padding1: [] as number[],
    };
    const sdkRes = dlmm.swapExactInQuoteAtBin(
      sdkBin(0n, y, qPrice) as never,
      binStep,
      sParameter as never,
      vParameter as never,
      new BN(amountIn.toString()),
      true,
      false,
      true,
    );

    expect(ours.totalAmountOut.toString()).toBe(sdkRes.amountOut.toString());
    // SDK returns LP fee (post protocol/LO split) as `fee`
    expect(ours.totalLpFee.toString()).toBe(sdkRes.fee.toString());
  });

  it("matches SDK when the bin is drained (multi-bin boundary)", () => {
    const binStep = 100;
    const binId = 10;
    const qPrice = qPriceFromId(binId, binStep);
    const y = 500_000n; // small: will be drained
    const amountIn = 10_000_000n;
    const vParameter = {
      volatilityAccumulator: 0,
      volatilityReference: 0,
      indexReference: binId,
      padding: [] as number[],
      lastUpdateTimestamp: new BN(1000),
      padding1: [] as number[],
    };
    const sdkRes = dlmm.swapExactInQuoteAtBin(
      sdkBin(0n, y, qPrice) as never,
      binStep,
      sParameter as never,
      vParameter as never,
      new BN(amountIn.toString()),
      true,
      false,
      true,
    );

    const bins = new Map<number, BinState>([
      [binId, { binId, x: 0n, y, supply: y, loAmount: 0n, loAskSide: false }],
    ]);
    const feeState = new DynamicFeeState(binStep, staticParams, {
      volatilityAccumulator: 0,
      volatilityReference: 0,
      indexReference: binId,
      lastUpdateTimestamp: 1000,
    });
    const ours = walkSwapExactIn({
      bins,
      binStep,
      startBin: binId,
      swapForY: true,
      amountIn,
      feeState,
      feeOnInput: true,
      supportsLimitOrder: false,
      timestamp: 1000,
      maxBins: 0, // single bin only, to compare the boundary fill
    });

    const fill = ours.fills[0]!;
    expect(fill.amountOut.toString()).toBe(sdkRes.amountOut.toString());
    expect(fill.lpFee.toString()).toBe(sdkRes.fee.toString());
    // input consumed by this bin (fee included) must match too
    expect(fill.amountIn.toString()).toBe(sdkRes.amountIn.toString());
    expect(fill.protocolFee.toString()).toBe(sdkRes.protocolFee.toString());
  });
});
