import { BASIS_POINT_MAX, FEE_PRECISION, MAX_FEE_RATE } from "./binMath.js";
import type { StaticFeeParams, VolatilityState } from "./types.js";

/** base fee rate in 1e9 precision: baseFactor × binStep × 10 × 10^power */
export function baseFeeRate(binStep: number, s: StaticFeeParams): bigint {
  return (
    BigInt(s.baseFactor) * BigInt(binStep) * 10n * 10n ** BigInt(s.baseFeePowerFactor)
  );
}

/** variable fee rate in 1e9 precision: ceil(vfc × (v_a × binStep)² / 1e11) */
export function variableFeeRate(binStep: number, s: StaticFeeParams, volatilityAccumulator: number): bigint {
  if (s.variableFeeControl <= 0) return 0n;
  const squared = (BigInt(volatilityAccumulator) * BigInt(binStep)) ** 2n;
  return (BigInt(s.variableFeeControl) * squared + 99_999_999_999n) / 100_000_000_000n;
}

/** total fee rate in 1e9 precision, capped at 10% */
export function totalFeeRate(binStep: number, s: StaticFeeParams, volatilityAccumulator: number): bigint {
  const total = baseFeeRate(binStep, s) + variableFeeRate(binStep, s, volatilityAccumulator);
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

/** fee taken out of a fee-included amount: ceil(amount × rate / 1e9) */
export function feeFromIncludedAmount(amount: bigint, rate: bigint): bigint {
  return (amount * rate + FEE_PRECISION - 1n) / FEE_PRECISION;
}

/** fee added on top of a fee-excluded amount: ceil(amount × rate / (1e9 − rate)) */
export function feeOnExcludedAmount(amount: bigint, rate: bigint): bigint {
  const denominator = FEE_PRECISION - rate;
  return (amount * rate + denominator - 1n) / denominator;
}

/** protocol's cut of a trading fee: floor(fee × protocolShare / 10000) */
export function protocolFeeOf(fee: bigint, s: StaticFeeParams): bigint {
  return (fee * BigInt(s.protocolShare)) / BigInt(BASIS_POINT_MAX);
}

/**
 * lb_clmm volatility state machine, replayed swap-by-swap.
 * Mirrors LbPair::update_references / update_volatility_accumulator.
 *
 * Flagged assumption: last_update_timestamp advances on EVERY swap (as in
 * Trader Joe LB v2.1, lb_clmm's design source, and the docs' "time since last
 * transaction"). The public lb_clmm repo strips handler bodies so this cannot
 * be read from source; the per-swap fee_bps residual calibration validates it
 * empirically.
 */
export class DynamicFeeState {
  v: VolatilityState;

  constructor(
    readonly binStep: number,
    readonly params: StaticFeeParams,
    initial?: VolatilityState,
  ) {
    this.v = initial
      ? { ...initial }
      : { volatilityAccumulator: 0, volatilityReference: 0, indexReference: 0, lastUpdateTimestamp: 0 };
  }

  /** Call once at the start of each swap with the pre-swap active bin. */
  updateReferences(activeId: number, currentTimestamp: number): void {
    const elapsed = currentTimestamp - this.v.lastUpdateTimestamp;
    if (elapsed >= this.params.filterPeriod) {
      this.v.indexReference = activeId;
      if (elapsed < this.params.decayPeriod) {
        this.v.volatilityReference = Math.floor(
          (this.v.volatilityAccumulator * this.params.reductionFactor) / BASIS_POINT_MAX,
        );
      } else {
        this.v.volatilityReference = 0;
      }
    }
    this.v.lastUpdateTimestamp = currentTimestamp;
  }

  /** Call for every bin the swap touches (with that bin as activeId). */
  updateVolatilityAccumulator(activeId: number): void {
    const deltaId = Math.abs(this.v.indexReference - activeId);
    this.v.volatilityAccumulator = Math.min(
      this.v.volatilityReference + deltaId * BASIS_POINT_MAX,
      this.params.maxVolatilityAccumulator,
    );
  }

  /** current total fee rate (1e9 precision) */
  currentRate(): bigint {
    return totalFeeRate(this.binStep, this.params, this.v.volatilityAccumulator);
  }

  clone(): DynamicFeeState {
    return new DynamicFeeState(this.binStep, this.params, this.v);
  }
}
