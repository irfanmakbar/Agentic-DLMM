import type { Db } from "./client.js";
import type {
  BinSnapshotRow,
  IngestCursorRow,
  LiquidityEventRow,
  NewBinSnapshot,
  NewLiquidityEvent,
  NewPool,
  NewPoolMetrics,
  NewSwap,
  PoolRow,
  SwapRow,
  ValidationPositionRow,
} from "./types.js";

const bn = (v: bigint | null | undefined) => (v == null ? null : v.toString());

export async function upsertPool(db: Db, p: NewPool): Promise<void> {
  await db.query(
    `insert into pools (
       address, token_x_mint, token_y_mint, token_x_symbol, token_y_symbol,
       token_x_decimals, token_y_decimals, bin_step,
       base_factor, base_fee_power_factor, variable_fee_control, filter_period,
       decay_period, reduction_factor, max_volatility_accumulator, protocol_share,
       pair_type, collect_fee_mode, supports_limit_order, params_updated_at, raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       case when $9::int is null then null else now() end, $20)
     on conflict (address) do update set
       token_x_symbol = coalesce(excluded.token_x_symbol, pools.token_x_symbol),
       token_y_symbol = coalesce(excluded.token_y_symbol, pools.token_y_symbol),
       token_x_decimals = coalesce(excluded.token_x_decimals, pools.token_x_decimals),
       token_y_decimals = coalesce(excluded.token_y_decimals, pools.token_y_decimals),
       base_factor = coalesce(excluded.base_factor, pools.base_factor),
       base_fee_power_factor = coalesce(excluded.base_fee_power_factor, pools.base_fee_power_factor),
       variable_fee_control = coalesce(excluded.variable_fee_control, pools.variable_fee_control),
       filter_period = coalesce(excluded.filter_period, pools.filter_period),
       decay_period = coalesce(excluded.decay_period, pools.decay_period),
       reduction_factor = coalesce(excluded.reduction_factor, pools.reduction_factor),
       max_volatility_accumulator = coalesce(excluded.max_volatility_accumulator, pools.max_volatility_accumulator),
       protocol_share = coalesce(excluded.protocol_share, pools.protocol_share),
       pair_type = coalesce(excluded.pair_type, pools.pair_type),
       collect_fee_mode = coalesce(excluded.collect_fee_mode, pools.collect_fee_mode),
       supports_limit_order = coalesce(excluded.supports_limit_order, pools.supports_limit_order),
       params_updated_at = case when excluded.base_factor is not null then now() else pools.params_updated_at end,
       raw = coalesce(excluded.raw, pools.raw)`,
    [
      p.address,
      p.tokenXMint,
      p.tokenYMint,
      p.tokenXSymbol ?? null,
      p.tokenYSymbol ?? null,
      p.tokenXDecimals ?? null,
      p.tokenYDecimals ?? null,
      p.binStep,
      p.baseFactor ?? null,
      p.baseFeePowerFactor ?? null,
      bn(p.variableFeeControl),
      p.filterPeriod ?? null,
      p.decayPeriod ?? null,
      p.reductionFactor ?? null,
      bn(p.maxVolatilityAccumulator),
      p.protocolShare ?? null,
      p.pairType ?? null,
      p.collectFeeMode ?? null,
      p.supportsLimitOrder ?? null,
      p.raw == null ? null : JSON.stringify(p.raw),
    ],
  );
}

export async function getPool(db: Db, address: string): Promise<PoolRow | null> {
  const { rows } = await db.query<PoolRow>("select * from pools where address = $1", [address]);
  return rows[0] ?? null;
}

export async function getWatchlistedPools(db: Db): Promise<PoolRow[]> {
  const { rows } = await db.query<PoolRow>("select * from pools where watchlisted order by address");
  return rows;
}

export async function setWatchlisted(db: Db, address: string, watchlisted: boolean): Promise<void> {
  await db.query(
    `update pools set watchlisted = $2,
       watchlisted_at = case when $2 and not watchlisted then now() else watchlisted_at end
     where address = $1`,
    [address, watchlisted],
  );
}

export async function insertPoolMetrics(db: Db, m: NewPoolMetrics): Promise<void> {
  await db.query(
    `insert into pool_metrics (
       pool, ts, price, active_bin, tvl, mcap, holders, organic_score,
       vol_30m, vol_1h, vol_2h, vol_4h, vol_12h, vol_24h,
       fees_30m, fees_1h, fees_2h, fees_4h, fees_12h, fees_24h, tx_5m,
       feetvl_proj_30m, feetvl_proj_1h, feetvl_proj_2h, feetvl_proj_4h,
       feetvl_proj_12h, feetvl_proj_24h,
       feetvl_min_projection, volume_uptrend, sol_usd, raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [
      m.pool, m.ts, m.price, m.activeBin, m.tvl, m.mcap, m.holders, m.organicScore,
      m.volumes["30m"] ?? null, m.volumes["1h"] ?? null, m.volumes["2h"] ?? null,
      m.volumes["4h"] ?? null, m.volumes["12h"] ?? null, m.volumes["24h"] ?? null,
      m.fees["30m"] ?? null, m.fees["1h"] ?? null, m.fees["2h"] ?? null,
      m.fees["4h"] ?? null, m.fees["12h"] ?? null, m.fees["24h"] ?? null, m.tx5m,
      m.feeTvlProjections["30m"] ?? null, m.feeTvlProjections["1h"] ?? null,
      m.feeTvlProjections["2h"] ?? null, m.feeTvlProjections["4h"] ?? null,
      m.feeTvlProjections["12h"] ?? null, m.feeTvlProjections["24h"] ?? null,
      m.feetvlMinProjection, m.volumeUptrend, m.solUsd,
      m.raw == null ? null : JSON.stringify(m.raw),
    ],
  );
}

export async function insertSwaps(db: Db, swaps: NewSwap[]): Promise<number> {
  if (swaps.length === 0) return 0;
  let inserted = 0;
  for (const s of swaps) {
    const res = await db.query(
      `insert into swaps (
         sig, event_ordinal, pool, slot, block_ts, swap_for_y, start_bin, end_bin,
         amount_in, amount_out, fee_bps, fee, mm_fee, protocol_fee, limit_order_fee,
         host_fee, fees_on_input, fees_on_token_x, raw
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (sig, event_ordinal) do nothing`,
      [
        s.sig, s.eventOrdinal, s.pool, s.slot, s.blockTs, s.swapForY, s.startBin, s.endBin,
        bn(s.amountIn), bn(s.amountOut), s.feeBps, bn(s.fee), bn(s.mmFee), bn(s.protocolFee),
        bn(s.limitOrderFee), bn(s.hostFee), s.feesOnInput, s.feesOnTokenX,
        s.raw == null ? null : JSON.stringify(s.raw),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export async function insertLiquidityEvents(db: Db, events: NewLiquidityEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  let inserted = 0;
  for (const e of events) {
    const res = await db.query(
      `insert into liquidity_events (
         sig, event_ordinal, pool, kind, position, owner, slot, block_ts,
         amount_x, amount_y, active_bin, raw
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (sig, event_ordinal) do nothing`,
      [
        e.sig, e.eventOrdinal, e.pool, e.kind, e.position, e.owner, e.slot, e.blockTs,
        bn(e.amountX), bn(e.amountY), e.activeBin,
        e.raw == null ? null : JSON.stringify(e.raw),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export async function insertBinSnapshot(db: Db, s: NewBinSnapshot): Promise<void> {
  await db.query(
    `insert into bin_snapshots (pool, ts, slot, active_bin, v_acc, v_ref, idx_ref, last_update_ts, bins)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [s.pool, s.ts, s.slot, s.activeBin, bn(s.vAcc), bn(s.vRef), s.idxRef, bn(s.lastUpdateTs), JSON.stringify(s.bins)],
  );
}

export async function getSwapsInRange(db: Db, pool: string, from: Date, to: Date): Promise<SwapRow[]> {
  const { rows } = await db.query<SwapRow>(
    `select * from swaps where pool = $1 and block_ts >= $2 and block_ts <= $3
     order by slot, event_ordinal`,
    [pool, from, to],
  );
  return rows;
}

export async function getBinSnapshotAtOrBefore(db: Db, pool: string, ts: Date): Promise<BinSnapshotRow | null> {
  const { rows } = await db.query<BinSnapshotRow>(
    `select * from bin_snapshots where pool = $1 and ts <= $2 order by ts desc limit 1`,
    [pool, ts],
  );
  return rows[0] ?? null;
}

export async function getBinSnapshotsInRange(db: Db, pool: string, from: Date, to: Date): Promise<BinSnapshotRow[]> {
  const { rows } = await db.query<BinSnapshotRow>(
    `select * from bin_snapshots where pool = $1 and ts > $2 and ts <= $3 order by ts`,
    [pool, from, to],
  );
  return rows;
}

export async function getLiquidityEventsForPosition(db: Db, position: string): Promise<LiquidityEventRow[]> {
  const { rows } = await db.query<LiquidityEventRow>(
    `select * from liquidity_events where position = $1 order by slot, event_ordinal`,
    [position],
  );
  return rows;
}

export async function getLiquidityEventsInRange(
  db: Db,
  pool: string,
  from: Date,
  to: Date,
): Promise<LiquidityEventRow[]> {
  const { rows } = await db.query<LiquidityEventRow>(
    `select * from liquidity_events where pool = $1 and block_ts >= $2 and block_ts <= $3
     order by slot, event_ordinal`,
    [pool, from, to],
  );
  return rows;
}

export async function filterUnprocessedSigs(db: Db, sigs: string[]): Promise<string[]> {
  if (sigs.length === 0) return [];
  const { rows } = await db.query<{ sig: string }>(
    "select sig from processed_txs where sig = any($1)",
    [sigs],
  );
  const seen = new Set(rows.map((r) => r.sig));
  return sigs.filter((s) => !seen.has(s));
}

export async function markTxProcessed(db: Db, sig: string, slot: number | null, pool: string): Promise<void> {
  await db.query(
    `insert into processed_txs (sig, slot, pool) values ($1, $2, $3)
     on conflict (sig) do update set slot = excluded.slot`,
    [sig, slot, pool],
  );
}

/**
 * Release fetch-failed txs (slot null) recorded in the last hour for a retry
 * (rows deleted so processSignatures picks them up again). Older failures are
 * considered permanently unavailable.
 */
export async function takeRetryableSigs(db: Db, limit = 200): Promise<Array<{ sig: string; pool: string | null }>> {
  const { rows } = await db.query<{ sig: string; pool: string | null }>(
    `delete from processed_txs
     where sig in (
       select sig from processed_txs
       where slot is null and processed_at > now() - interval '1 hour'
       order by processed_at desc limit $1
     )
     returning sig, pool`,
    [limit],
  );
  return rows;
}

export async function getIngestCursor(db: Db, pool: string): Promise<IngestCursorRow | null> {
  const { rows } = await db.query<IngestCursorRow>("select * from ingest_cursors where pool = $1", [pool]);
  return rows[0] ?? null;
}

export async function updateIngestCursor(
  db: Db,
  pool: string,
  patch: Partial<{
    newestSig: string;
    newestSlot: number;
    oldestSig: string;
    oldestSlot: number;
    backfillComplete: boolean;
  }>,
): Promise<void> {
  await db.query(
    `insert into ingest_cursors (pool, newest_sig, newest_slot, oldest_sig, oldest_slot, backfill_complete)
     values ($1,$2,$3,$4,$5,coalesce($6,false))
     on conflict (pool) do update set
       newest_sig = coalesce(excluded.newest_sig, ingest_cursors.newest_sig),
       newest_slot = coalesce(excluded.newest_slot, ingest_cursors.newest_slot),
       oldest_sig = coalesce(excluded.oldest_sig, ingest_cursors.oldest_sig),
       oldest_slot = coalesce(excluded.oldest_slot, ingest_cursors.oldest_slot),
       backfill_complete = coalesce($6, ingest_cursors.backfill_complete),
       updated_at = now()`,
    [
      pool,
      patch.newestSig ?? null,
      patch.newestSlot ?? null,
      patch.oldestSig ?? null,
      patch.oldestSlot ?? null,
      patch.backfillComplete ?? null,
    ],
  );
}

export async function registerValidationPosition(
  db: Db,
  v: { pool: string; positionPubkey: string; wallet?: string | null; notes?: string | null },
): Promise<void> {
  await db.query(
    `insert into validation_positions (pool, position_pubkey, wallet, notes)
     values ($1,$2,$3,$4)
     on conflict (position_pubkey) do nothing`,
    [v.pool, v.positionPubkey, v.wallet ?? null, v.notes ?? null],
  );
}

export async function getOpenValidationPools(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ pool: string }>(
    "select distinct pool from validation_positions where status = 'open'",
  );
  return rows.map((r) => r.pool);
}

export async function getValidationPositions(db: Db, status?: string): Promise<ValidationPositionRow[]> {
  const { rows } = status
    ? await db.query<ValidationPositionRow>("select * from validation_positions where status = $1 order by id", [status])
    : await db.query<ValidationPositionRow>("select * from validation_positions order by id");
  return rows;
}

export async function updateValidationPosition(
  db: Db,
  positionPubkey: string,
  patch: Partial<{
    openSig: string;
    closeSig: string;
    openTs: Date;
    closeTs: Date;
    status: string;
    predicted: unknown;
    realized: unknown;
    feeErrorPct: number;
    ilErrorPct: number;
    netErrorPct: number;
    notes: string;
  }>,
): Promise<void> {
  await db.query(
    `update validation_positions set
       open_sig = coalesce($2, open_sig),
       close_sig = coalesce($3, close_sig),
       open_ts = coalesce($4, open_ts),
       close_ts = coalesce($5, close_ts),
       status = coalesce($6, status),
       predicted = coalesce($7, predicted),
       realized = coalesce($8, realized),
       fee_error_pct = coalesce($9, fee_error_pct),
       il_error_pct = coalesce($10, il_error_pct),
       net_error_pct = coalesce($11, net_error_pct),
       notes = coalesce($12, notes)
     where position_pubkey = $1`,
    [
      positionPubkey,
      patch.openSig ?? null,
      patch.closeSig ?? null,
      patch.openTs ?? null,
      patch.closeTs ?? null,
      patch.status ?? null,
      patch.predicted == null ? null : JSON.stringify(patch.predicted),
      patch.realized == null ? null : JSON.stringify(patch.realized),
      patch.feeErrorPct ?? null,
      patch.ilErrorPct ?? null,
      patch.netErrorPct ?? null,
      patch.notes ?? null,
    ],
  );
}
