import { DynamicFeeState, binPriceRaw, type BinState } from "@agentic-dlmm/core";
import {
  getBinSnapshotAtOrBefore,
  getBinSnapshotsInRange,
  getPool,
  getSwapsInRange,
  type BinSnapshotRow,
  type Db,
  type SwapRow,
} from "@agentic-dlmm/db";
import type { MeteoraDatapi, PositionEvent } from "@agentic-dlmm/data";
import type { Connection } from "@solana/web3.js";
import { binsFromSnapshot, volatilityFromSnapshot } from "../binReconstruction.js";
import { HypotheticalPosition } from "../position.js";
import { poolInfoFromRow, replaySwap } from "../engine.js";
import { depositBinsFromTx, type BinDeposit } from "./depositShape.js";
import type { PoolInfo } from "../types.js";

/**
 * Tier-2 validation: replay a real third-party position through the engine
 * and compare predicted LP fees vs the fees the datapi says it earned
 * (claim_fee events). Requires local capture (swaps + bin snapshots) covering
 * the position's lifetime.
 *
 * Per-bin deposit amounts are reconstructed by decoding the add-liquidity
 * instruction from the open transaction (strategy shape: spot/curve/bidAsk).
 * Without an RPC connection this falls back to a uniform spread over the
 * position's bin range — documented approximation, wildly wrong for
 * BidAsk-shaped positions.
 */

export interface PositionReplayResult {
  position: string;
  pool: string;
  window: { from: Date; to: Date };
  predictedFeesX: bigint;
  predictedFeesY: bigint;
  claimedFeesX: bigint;
  claimedFeesY: bigint;
  /** relative error of predicted vs claimed fee value (Y units), percent */
  feeErrorPct: number | null;
  /** actual deposits/withdrawals from datapi events (raw units) */
  depositX: bigint;
  depositY: bigint;
  withdrawnX: bigint;
  withdrawnY: bigint;
  /** engine-predicted withdrawal amounts at the same events */
  predictedWithdrawnX: bigint;
  predictedWithdrawnY: bigint;
  /** IL vs HODL in Y units at the final active bin: realized and predicted */
  realizedIlY: number | null;
  predictedIlY: number | null;
  ilErrorPct: number | null;
  /** final active bin price used for valuations */
  exitPriceRaw: number;
  swapsReplayed: number;
  snapshotsResynced: number;
  notes: string[];
}

/** datapi UI decimal string ("0.999999964") -> raw integer units */
export function uiToRaw(ui: string, decimals: number): bigint {
  const [whole, frac = ""] = ui.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** fallback: uniform spot spread of the totals across [lowerBin, upperBin] */
function uniformDeposits(
  activeBin: number,
  lowerBin: number,
  upperBin: number,
  amountX: bigint,
  amountY: bigint,
): BinDeposit[] {
  const yBins: number[] = [];
  const xBins: number[] = [];
  for (let b = lowerBin; b <= upperBin; b++) {
    if (b <= activeBin) yBins.push(b);
    if (b >= activeBin) xBins.push(b);
  }
  const yPer = yBins.length > 0 ? amountY / BigInt(yBins.length) : 0n;
  const xPer = xBins.length > 0 ? amountX / BigInt(xBins.length) : 0n;
  const out = new Map<number, BinDeposit>();
  for (const b of yBins) out.set(b, { binId: b, x: 0n, y: yPer });
  for (const b of xBins) {
    const d = out.get(b) ?? { binId: b, x: 0n, y: 0n };
    d.x += xPer;
    out.set(b, d);
  }
  return [...out.values()];
}

export async function replayThirdPartyPosition(
  db: Db,
  datapi: MeteoraDatapi,
  positionAddress: string,
  binRange?: { lower: number; upper: number },
  connection?: Connection,
): Promise<PositionReplayResult> {
  const notes: string[] = [];
  const events = await datapi.getPositionHistoricalEvents(positionAddress);
  if (events.length === 0) throw new Error("position has no historical events on datapi");

  const poolAddr = events[0]!.poolAddress;
  const poolRow = await getPool(db, poolAddr);
  if (!poolRow) throw new Error(`pool ${poolAddr} not captured locally — cannot replay`);
  const pool: PoolInfo = poolInfoFromRow(poolRow);

  // datapi amounts are UI decimals and blockTime is in milliseconds
  const rawX = (e: PositionEvent) => uiToRaw(e.amountX, pool.tokenXDecimals);
  const rawY = (e: PositionEvent) => uiToRaw(e.amountY, pool.tokenYDecimals);
  const deposits = events.filter((e) => e.eventType === "add");
  const withdrawals = events.filter((e) => e.eventType === "remove");
  const claims = events.filter((e) => e.eventType === "claim_fee");
  const claimedFeesX = claims.reduce((a, e) => a + rawX(e), 0n);
  const claimedFeesY = claims.reduce((a, e) => a + rawY(e), 0n);
  const times = events.map((e) => e.blockTime);
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times));

  const snap0 = await getBinSnapshotAtOrBefore(db, poolAddr, from);
  if (!snap0) throw new Error(`no bin snapshot at or before ${from.toISOString()} for ${poolAddr}`);
  const gapMin = (from.getTime() - snap0.ts.getTime()) / 60_000;
  if (gapMin > 10) notes.push(`nearest snapshot ${Math.round(gapMin)}min before position open`);

  let bins = binsFromSnapshot(snap0.bins);
  const feeState = new DynamicFeeState(pool.binStep, pool.params, volatilityFromSnapshot(snap0));
  let activeBin = snap0.active_bin;
  // the position exists on-chain: snapshots taken after its open already
  // include its liquidity, so track share without re-adding amounts
  const position = new HypotheticalPosition(pool.binStep, true);

  const [warmupSwaps, swaps, snapshots] = await Promise.all([
    getSwapsInRange(db, poolAddr, snap0.ts, from),
    getSwapsInRange(db, poolAddr, from, to),
    getBinSnapshotsInRange(db, poolAddr, from, to),
  ]);

  type Ev =
    | { ts: number; kind: "swap"; swap: SwapRow }
    | { ts: number; kind: "snapshot"; snapshot: BinSnapshotRow }
    | { ts: number; kind: "deposit" | "withdraw"; ev: PositionEvent };

  const stream: Ev[] = [
    ...warmupSwaps.map((s): Ev => ({ ts: s.block_ts.getTime(), kind: "swap", swap: s })),
    ...swaps.map((s): Ev => ({ ts: s.block_ts.getTime(), kind: "swap", swap: s })),
    ...snapshots.map((s): Ev => ({ ts: s.ts.getTime(), kind: "snapshot", snapshot: s })),
    ...deposits.map((e): Ev => ({ ts: e.blockTime, kind: "deposit", ev: e })),
    ...withdrawals.map((e): Ev => ({ ts: e.blockTime, kind: "withdraw", ev: e })),
  ].sort((a, b) => a.ts - b.ts);

  let swapsReplayed = 0;
  let snapshotsResynced = 0;
  let lower = binRange?.lower;
  let upper = binRange?.upper;

  // bin range from the datapi PnL endpoint (keyed by pool + owner wallet)
  if (lower == null || upper == null) {
    try {
      const pnl = await datapi.getPositionPnl(poolAddr, events[0]!.userAddress, "all");
      const rec = pnl.positions.find((p) => p.positionAddress === positionAddress);
      if (rec) {
        lower = rec.lowerBinId;
        upper = rec.upperBinId;
        notes.push(`bin range [${lower}, ${upper}] from datapi pnl`);
      }
    } catch (err) {
      notes.push(`pnl lookup failed: ${(err as Error).message}`);
    }
  }
  let predictedWithdrawnX = 0n;
  let predictedWithdrawnY = 0n;
  let realizedWithdrawnX = 0n;
  let realizedWithdrawnY = 0n;

  for (const item of stream) {
    switch (item.kind) {
      case "swap": {
        const withPosition = position.shares.size > 0 ? position : null;
        replaySwap(pool, bins, feeState, item.swap, withPosition);
        activeBin = item.swap.end_bin;
        swapsReplayed++;
        break;
      }
      case "snapshot": {
        const fresh = binsFromSnapshot(item.snapshot.bins);
        position.resync(bins, fresh);
        bins = fresh;
        activeBin = item.snapshot.active_bin;
        const v = volatilityFromSnapshot(item.snapshot);
        feeState.v.volatilityAccumulator = v.volatilityAccumulator;
        feeState.v.volatilityReference = v.volatilityReference;
        feeState.v.indexReference = v.indexReference;
        feeState.v.lastUpdateTimestamp = v.lastUpdateTimestamp;
        snapshotsResynced++;
        break;
      }
      case "deposit": {
        let perBin: BinDeposit[] | null = null;
        if (connection) {
          try {
            const tx = await connection.getParsedTransaction(item.ev.signature, {
              maxSupportedTransactionVersion: 0,
            });
            if (tx) {
              const active = bins.get(activeBin);
              perBin = depositBinsFromTx(
                tx,
                positionAddress,
                pool.binStep,
                activeBin,
                active?.x ?? 0n,
                active?.y ?? 0n,
              );
              if (perBin) notes.push(`deposit shape decoded from tx ${item.ev.signature.slice(0, 16)}…`);
            }
          } catch (err) {
            notes.push(`deposit tx decode failed (${(err as Error).message}); falling back to uniform`);
          }
        }
        if (!perBin) {
          if (lower == null || upper == null) {
            lower = activeBin - 34;
            upper = activeBin + 34;
            notes.push(`bin range unknown (pnl lookup empty); assumed [${lower}, ${upper}] around active bin`);
          }
          notes.push(`uniform spread over [${lower}, ${upper}] (no tx decode)`);
          perBin = uniformDeposits(activeBin, lower, upper, rawX(item.ev), rawY(item.ev));
        }
        for (const d of perBin) position.deposit(bins, d.binId, d.x, d.y);
        break;
      }
      case "withdraw": {
        // proportional partial exit by value; full exit when it covers holdings
        const price = binPriceRaw(activeBin, pool.binStep);
        const h = position.holdings(bins);
        const heldValue = Number(h.x) * price + Number(h.y);
        const removedValue = Number(rawX(item.ev)) * price + Number(rawY(item.ev));
        const fraction = heldValue <= 0 ? 1 : Math.min(1, removedValue / heldValue);
        const out = position.withdraw(bins, fraction);
        predictedWithdrawnX += out.x;
        predictedWithdrawnY += out.y;
        realizedWithdrawnX += rawX(item.ev);
        realizedWithdrawnY += rawY(item.ev);
        break;
      }
    }
  }

  // any liquidity still in the position at the end counts as withdrawn now
  const remaining = position.withdraw(bins);
  predictedWithdrawnX += remaining.x;
  predictedWithdrawnY += remaining.y;

  const price = binPriceRaw(activeBin, pool.binStep);
  const predValueY = Number(position.feesX) * price + Number(position.feesY);
  const claimValueY = Number(claimedFeesX) * price + Number(claimedFeesY);
  const feeErrorPct = claimValueY === 0 ? null : (100 * (predValueY - claimValueY)) / claimValueY;

  // IL vs HODL valued at the exit price (Y units)
  const hodlValueY = Number(position.depositX) * price + Number(position.depositY);
  const fullyClosed = withdrawals.length > 0;
  const realizedIlY = fullyClosed
    ? hodlValueY - (Number(realizedWithdrawnX) * price + Number(realizedWithdrawnY))
    : null;
  const predictedIlY = hodlValueY - (Number(predictedWithdrawnX) * price + Number(predictedWithdrawnY));
  const ilErrorPct =
    realizedIlY == null || realizedIlY === 0 ? null : (100 * (predictedIlY - realizedIlY)) / Math.abs(realizedIlY);

  return {
    position: positionAddress,
    pool: poolAddr,
    window: { from, to },
    predictedFeesX: position.feesX,
    predictedFeesY: position.feesY,
    claimedFeesX,
    claimedFeesY,
    feeErrorPct,
    depositX: position.depositX,
    depositY: position.depositY,
    withdrawnX: realizedWithdrawnX,
    withdrawnY: realizedWithdrawnY,
    predictedWithdrawnX,
    predictedWithdrawnY,
    realizedIlY,
    predictedIlY,
    ilErrorPct,
    exitPriceRaw: price,
    swapsReplayed,
    snapshotsResynced,
    notes,
  };
}
