import { DynamicFeeState, totalFeeRate, type StaticFeeParams, type VolatilityState } from "@agentic-dlmm/core";

/**
 * Tier-1 intrinsic calibration: every Swap2Evt carries the applied total fee
 * rate (`fee_bps`, 1e9 precision). We replay the volatility state machine
 * over the captured swap stream and compare our predicted rate per swap.
 *
 * The exact bin the program uses when emitting fee_bps is not readable from
 * the stripped public source, so we score both hypotheses. Empirically
 * settled 2026-07-02 on live capture (RUSH-SOL bs100, 80 swaps): the END-bin
 * hypothesis matches 100% exactly; start-bin only on single-bin swaps.
 * v_a per bin is a pure function of reference distance (not a running sum):
 * rate(bin) = totalFeeRate with v_a = min(v_ref + |i_ref − bin|·1e4, cap).
 *
 * Warm-up: residuals are recorded only once the state is exact — either
 * seeded from an on-chain snapshot, or after the first inter-swap gap
 * ≥ decayPeriod (volatilityReference resets to 0; exact from then on if no
 * swaps were missed).
 */

export interface ResidualSwap {
  sig: string;
  startBin: number;
  endBin: number;
  /** unix seconds */
  ts: number;
  /** observed total fee rate, 1e9 precision */
  feeBps: number;
}

/** On-chain volatility state observed at some wall-clock time (bin snapshot). */
export interface ResidualCheckpoint {
  /** unix seconds (snapshot capture time) */
  ts: number;
  state: VolatilityState;
}

export interface ResidualStats {
  n: number;
  exact: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  worst: Array<{ sig: string; predicted: number; observed: number; rel: number }>;
}

export interface ResidualReport {
  warmupSkipped: number;
  seededFrom: "snapshot" | "decay-gap" | "cold";
  /** hypothesis A: fee_bps computed with v_a at the swap's start bin */
  startBin: ResidualStats;
  /** hypothesis B: fee_bps computed with v_a at the swap's end bin */
  endBin: ResidualStats;
}

function stats(residuals: Array<{ sig: string; predicted: number; observed: number; rel: number }>): ResidualStats {
  const sorted = residuals.map((r) => r.rel).sort((a, b) => a - b);
  const q = (p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return {
    n: residuals.length,
    exact: residuals.filter((r) => r.predicted === r.observed).length,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
    worst: [...residuals].sort((a, b) => b.rel - a.rel).slice(0, 5),
  };
}

export function feeResidualReport(
  binStep: number,
  params: StaticFeeParams,
  swaps: ResidualSwap[],
  seed?: VolatilityState,
  /** on-chain state checkpoints (bin snapshots), sorted by ts ascending;
   * applied between swaps so reference drift from missed swaps self-heals */
  checkpoints: ResidualCheckpoint[] = [],
): ResidualReport {
  const state = seed
    ? new DynamicFeeState(binStep, params, seed)
    : new DynamicFeeState(binStep, params, {
        volatilityAccumulator: 0,
        volatilityReference: 0,
        indexReference: swaps[0]?.startBin ?? 0,
        lastUpdateTimestamp: swaps[0]?.ts ?? 0,
      });
  let warmedUp = seed != null;
  let seededFrom: ResidualReport["seededFrom"] = seed != null ? "snapshot" : "cold";

  const startResiduals: Array<{ sig: string; predicted: number; observed: number; rel: number }> = [];
  const endResiduals: Array<{ sig: string; predicted: number; observed: number; rel: number }> = [];
  let warmupSkipped = 0;
  let cpIndex = 0;

  const rateAt = (bin: number) => {
    const deltaId = Math.abs(state.v.indexReference - bin);
    const vAcc = Math.min(state.v.volatilityReference + deltaId * 10_000, params.maxVolatilityAccumulator);
    return Number(totalFeeRate(binStep, params, vAcc));
  };

  for (const s of swaps) {
    // adopt the latest on-chain checkpoint taken before this swap
    while (cpIndex < checkpoints.length && checkpoints[cpIndex]!.ts <= s.ts) {
      state.v = { ...checkpoints[cpIndex]!.state };
      warmedUp = true;
      cpIndex++;
    }
    if (!warmedUp && s.ts - state.v.lastUpdateTimestamp >= params.decayPeriod) {
      warmedUp = true;
      seededFrom = "decay-gap";
    }
    state.updateReferences(s.startBin, s.ts);
    const predictedStart = rateAt(s.startBin);
    const predictedEnd = rateAt(s.endBin);
    // leave the machine in the end-of-swap state for the next iteration
    state.updateVolatilityAccumulator(s.endBin);

    if (!warmedUp) {
      warmupSkipped++;
      continue;
    }
    const rel = (predicted: number) => (s.feeBps === 0 ? 0 : Math.abs(predicted - s.feeBps) / s.feeBps);
    startResiduals.push({ sig: s.sig, predicted: predictedStart, observed: s.feeBps, rel: rel(predictedStart) });
    endResiduals.push({ sig: s.sig, predicted: predictedEnd, observed: s.feeBps, rel: rel(predictedEnd) });
  }

  return {
    warmupSkipped,
    seededFrom,
    startBin: stats(startResiduals),
    endBin: stats(endResiduals),
  };
}
