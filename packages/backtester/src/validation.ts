import {
  getLiquidityEventsForPosition,
  getValidationPositions,
  registerValidationPosition,
  updateValidationPosition,
  type Db,
  type ValidationPositionRow,
} from "@agentic-dlmm/db";
import type { MeteoraDatapi } from "@agentic-dlmm/data";
import type { Connection } from "@solana/web3.js";
import { replayThirdPartyPosition } from "./calibration/positionReplay.js";

/**
 * Tier-3 validation-position tooling. Positions are opened manually in the
 * Meteora UI, registered here by pubkey, auto-tracked from the captured event
 * stream (their pool is pinned into the watchlist via getOpenValidationPools),
 * and compared predicted-vs-realized once closed.
 */

export async function register(
  db: Db,
  v: { pool: string; positionPubkey: string; wallet?: string; notes?: string },
): Promise<void> {
  await registerValidationPosition(db, v);
}

export interface TrackOutcome {
  position: string;
  status: string;
  openTs: Date | null;
  closeTs: Date | null;
}

/** Update open/close sig+ts of registered positions from captured events. */
export async function track(db: Db): Promise<TrackOutcome[]> {
  const outcomes: TrackOutcome[] = [];
  const rows = await getValidationPositions(db);
  for (const row of rows) {
    if (row.status === "compared") {
      outcomes.push({ position: row.position_pubkey, status: row.status, openTs: row.open_ts, closeTs: row.close_ts });
      continue;
    }
    const events = await getLiquidityEventsForPosition(db, row.position_pubkey);
    const create = events.find((e) => e.kind === "position_create" || e.kind === "add");
    const close = events.find((e) => e.kind === "position_close");
    const lastRemove = [...events].reverse().find((e) => e.kind === "remove");
    const closed = close ?? lastRemove;

    const patch: Parameters<typeof updateValidationPosition>[2] = {};
    if (create && !row.open_sig) {
      patch.openSig = create.sig;
      patch.openTs = create.block_ts;
    }
    if (closed) {
      patch.closeSig = closed.sig;
      patch.closeTs = closed.block_ts;
      patch.status = "closed";
    }
    if (Object.keys(patch).length > 0) await updateValidationPosition(db, row.position_pubkey, patch);
    outcomes.push({
      position: row.position_pubkey,
      status: closed ? "closed" : row.status,
      openTs: create?.block_ts ?? row.open_ts,
      closeTs: closed?.block_ts ?? row.close_ts,
    });
  }
  return outcomes;
}

export interface CompareOutcome {
  position: string;
  feeErrorPct: number | null;
  ilErrorPct: number | null;
  notes: string[];
}

/** Replay closed validation positions; store predicted vs realized + errors. */
export async function compare(
  db: Db,
  datapi: MeteoraDatapi,
  onlyPosition?: string,
  connection?: Connection,
): Promise<CompareOutcome[]> {
  const rows = (await getValidationPositions(db, "closed")).filter(
    (r: ValidationPositionRow) => !onlyPosition || r.position_pubkey === onlyPosition,
  );
  const outcomes: CompareOutcome[] = [];
  for (const row of rows) {
    const res = await replayThirdPartyPosition(db, datapi, row.position_pubkey, undefined, connection);
    const predicted = {
      feesX: res.predictedFeesX.toString(),
      feesY: res.predictedFeesY.toString(),
      withdrawnX: res.predictedWithdrawnX.toString(),
      withdrawnY: res.predictedWithdrawnY.toString(),
      ilY: res.predictedIlY,
      exitPriceRaw: res.exitPriceRaw,
      swapsReplayed: res.swapsReplayed,
      snapshotsResynced: res.snapshotsResynced,
    };
    const realized = {
      feesX: res.claimedFeesX.toString(),
      feesY: res.claimedFeesY.toString(),
      depositX: res.depositX.toString(),
      depositY: res.depositY.toString(),
      withdrawnX: res.withdrawnX.toString(),
      withdrawnY: res.withdrawnY.toString(),
      ilY: res.realizedIlY,
    };
    await updateValidationPosition(db, row.position_pubkey, {
      predicted,
      realized,
      feeErrorPct: res.feeErrorPct ?? undefined,
      ilErrorPct: res.ilErrorPct ?? undefined,
      status: "compared",
      notes: res.notes.join("; ") || undefined,
    });
    outcomes.push({
      position: row.position_pubkey,
      feeErrorPct: res.feeErrorPct,
      ilErrorPct: res.ilErrorPct,
      notes: res.notes,
    });
  }
  return outcomes;
}
