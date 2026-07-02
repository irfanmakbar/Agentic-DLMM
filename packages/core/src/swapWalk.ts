import { getAmountIn, getAmountOut, qPriceFromId } from "./binMath.js";
import { DynamicFeeState, feeFromIncludedAmount, feeOnExcludedAmount } from "./dynamicFee.js";
import type { BinState } from "./types.js";

/** LO participants receive this share of the LO slice of the fee (bps, from IDL) */
const LIMIT_ORDER_FEE_SHARE = 5_000n;
const BPS = 10_000n;

export interface BinFill {
  binId: number;
  /** input consumed in this bin, fee included */
  amountIn: bigint;
  /** output paid from this bin, fee deducted when fee-on-output */
  amountOut: bigint;
  /** output paid from MM (LP) liquidity only */
  mmAmountOut: bigint;
  /** total trading fee charged for this bin's fill */
  tradingFee: bigint;
  /** portion of tradingFee accruing to the bin's LPs */
  lpFee: bigint;
  /** portion of tradingFee accruing to limit-order participants */
  loFee: bigint;
  /** portion of tradingFee accruing to the protocol */
  protocolFee: bigint;
  /** fee rate used for this fill (1e9 precision) */
  rate: bigint;
}

export interface WalkResult {
  fills: BinFill[];
  endBin: number;
  /** total input consumed, fee included */
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  totalTradingFee: bigint;
  totalLpFee: bigint;
  totalProtocolFee: bigint;
  /** input that could not be filled (ran out of liquidity in provided bins) */
  amountLeft: bigint;
}

export interface WalkParams {
  /** mutable bin states keyed by binId; composition updated in place */
  bins: Map<number, BinState>;
  binStep: number;
  startBin: number;
  swapForY: boolean;
  /** total input amount (fee included when feeOnInput) */
  amountIn: bigint;
  feeState: DynamicFeeState;
  feeOnInput: boolean;
  supportsLimitOrder: boolean;
  /** stop walking past this many bins (safety bound); defaults to 1400 */
  maxBins?: number;
  /** block timestamp of the swap (drives reference decay) */
  timestamp: number;
}

interface FillInResult {
  amountIn: bigint;
  amountLeft: bigint;
  outAmount: bigint;
}

/** SDK calculateExactInFillAmount: fill up to maxAmountOut at qPrice */
function fillExactIn(qPrice: bigint, amount: bigint, maxAmountOut: bigint, swapForY: boolean): FillInResult {
  if (maxAmountOut <= 0n) return { amountIn: 0n, amountLeft: amount, outAmount: 0n };
  const maxAmountIn = getAmountIn(qPrice, maxAmountOut, swapForY, true);
  if (amount >= maxAmountIn) {
    return { amountIn: maxAmountIn, amountLeft: amount - maxAmountIn, outAmount: maxAmountOut };
  }
  let out = getAmountOut(qPrice, amount, swapForY);
  if (out > maxAmountOut) out = maxAmountOut;
  return { amountIn: amount, amountLeft: 0n, outAmount: out };
}

/**
 * Replays one exact-in swap through per-bin constant-sum liquidity, mirroring
 * lb_clmm / SDK swapExactInQuoteAtBin bin by bin: update references once, then
 * per touched bin update the volatility accumulator and fill at that bin's
 * price with that bin's rate — MM liquidity first, then limit-order liquidity
 * at the same price. Mutates `bins` composition and `feeState`.
 *
 * Fee handling (exact SDK semantics per bin):
 * - feeOnInput: fee stripped from the fee-included candidate before filling;
 *   if the bin absorbs everything the up-front fee stands, otherwise the fee
 *   is recomputed on the consumed slice only.
 * - fee on output: fee deducted from the bin's gross output.
 * - split: mmFee = ceil(fee × mmAmountIn / amountIn); protocol takes
 *   floor(mmFee × protocolShare / 1e4) plus half of the LO slice; LO
 *   participants get floor(loSlice × 1/2); LPs get the rest of the MM slice.
 */
export function walkSwapExactIn(p: WalkParams): WalkResult {
  const fills: BinFill[] = [];
  const dir = p.swapForY ? -1 : 1;
  const maxBins = p.maxBins ?? 1400;
  let binId = p.startBin;
  let remainingIn = p.amountIn;
  let totalIn = 0n;
  let totalOut = 0n;
  let totalFee = 0n;
  let totalLpFee = 0n;
  let totalProtocolFee = 0n;

  p.feeState.updateReferences(p.startBin, p.timestamp);

  let steps = 0;
  while (remainingIn > 0n && steps++ <= maxBins) {
    const bin = p.bins.get(binId);
    const mmAvailable = bin ? (p.swapForY ? bin.y : bin.x) : 0n;
    const loAvailable =
      bin && p.supportsLimitOrder && bin.loAmount > 0n && bin.loAskSide !== p.swapForY ? bin.loAmount : 0n;

    if (mmAvailable + loAvailable > 0n) {
      p.feeState.updateVolatilityAccumulator(binId);
      const rate = p.feeState.currentRate();
      const qPrice = qPriceFromId(binId, p.binStep);

      // strip input fee from the full remaining (fee-included) amount
      let candidateExcl = remainingIn;
      let tradingFee = 0n;
      if (p.feeOnInput) {
        tradingFee = feeFromIncludedAmount(remainingIn, rate);
        candidateExcl = remainingIn - tradingFee;
      }

      // MM liquidity first, then limit orders at the same price
      const mmFill = fillExactIn(qPrice, candidateExcl, mmAvailable, p.swapForY);
      let loFill: FillInResult = { amountIn: 0n, amountLeft: mmFill.amountLeft, outAmount: 0n };
      if (mmFill.amountLeft > 0n && loAvailable > 0n) {
        loFill = fillExactIn(qPrice, mmFill.amountLeft, loAvailable, p.swapForY);
      }
      const usedExcl = mmFill.amountIn + loFill.amountIn;
      const grossOut = mmFill.outAmount + loFill.outAmount;
      const amountLeftExcl = loFill.amountLeft;

      if (usedExcl > 0n || grossOut > 0n) {
        // fee actually charged for this bin's consumed slice
        let includedIn = remainingIn;
        if (amountLeftExcl > 0n) {
          if (p.feeOnInput) {
            tradingFee = feeOnExcludedAmount(usedExcl, rate);
            includedIn = usedExcl + tradingFee;
          } else {
            includedIn = usedExcl;
          }
        }
        let outAfterFee = grossOut;
        if (!p.feeOnInput) {
          tradingFee = feeFromIncludedAmount(grossOut, rate);
          outAfterFee = grossOut - tradingFee;
        }

        // split (SDK splitFee): MM share pro-rated by input, ceiling
        const mmFee = usedExcl > 0n ? (tradingFee * mmFill.amountIn + usedExcl - 1n) / usedExcl : tradingFee;
        const loSlice = tradingFee - mmFee;
        const loFee = (loSlice * LIMIT_ORDER_FEE_SHARE) / BPS;
        const mmProtocolFee = (mmFee * BigInt(p.feeState.params.protocolShare)) / BPS;
        const protocolFee = mmProtocolFee + (loSlice - loFee);
        const lpFee = mmFee - mmProtocolFee;

        // constant-sum composition update: out-token leaves, in-token enters MM side
        if (bin && mmFill.outAmount > 0n) {
          if (p.swapForY) {
            bin.y -= mmFill.outAmount;
            bin.x += mmFill.amountIn;
          } else {
            bin.x -= mmFill.outAmount;
            bin.y += mmFill.amountIn;
          }
        }
        if (bin && loFill.outAmount > 0n) {
          bin.loAmount -= loFill.outAmount;
        }

        fills.push({
          binId,
          amountIn: includedIn,
          amountOut: outAfterFee,
          mmAmountOut: mmFill.outAmount,
          tradingFee,
          lpFee,
          loFee,
          protocolFee,
          rate,
        });

        totalIn += includedIn;
        totalOut += outAfterFee;
        totalFee += tradingFee;
        totalLpFee += lpFee;
        totalProtocolFee += protocolFee;
        remainingIn -= includedIn;
        if (remainingIn < 0n) remainingIn = 0n;
      }
    }
    if (remainingIn > 0n) binId += dir;
  }

  return {
    fills,
    endBin: fills.length > 0 ? fills[fills.length - 1]!.binId : p.startBin,
    totalAmountIn: totalIn,
    totalAmountOut: totalOut,
    totalTradingFee: totalFee,
    totalLpFee,
    totalProtocolFee,
    amountLeft: remainingIn,
  };
}
