import type { BinState } from "@agentic-dlmm/core";
import type { BinSnapshotRow, SnapshotBin } from "@agentic-dlmm/db";

/** Build the mutable per-bin pool state from a stored snapshot. */
export function binsFromSnapshot(bins: SnapshotBin[]): Map<number, BinState> {
  const m = new Map<number, BinState>();
  for (const b of bins) {
    m.set(b.i, {
      binId: b.i,
      x: BigInt(b.x),
      y: BigInt(b.y),
      supply: BigInt(b.s),
      loAmount: b.lo ? BigInt(b.lo) : 0n,
      loAskSide: b.loAsk ?? false,
    });
  }
  return m;
}

/** Volatility state stored alongside a snapshot (may be absent on old rows). */
export function volatilityFromSnapshot(row: BinSnapshotRow): {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: number;
} {
  return {
    volatilityAccumulator: row.v_acc == null ? 0 : Number(row.v_acc),
    volatilityReference: row.v_ref == null ? 0 : Number(row.v_ref),
    indexReference: row.idx_ref ?? row.active_bin,
    lastUpdateTimestamp: row.last_update_ts == null ? 0 : Number(row.last_update_ts),
  };
}
