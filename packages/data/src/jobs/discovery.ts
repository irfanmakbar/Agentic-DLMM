import { geekladEstimate } from "@agentic-dlmm/core";
import {
  type Db,
  getPool,
  getWatchlistedPools,
  setWatchlisted,
  upsertPool,
} from "@agentic-dlmm/db";
import { SOL_MINT } from "../clients/jupiter.js";
import type { DatapiPool, MeteoraDatapi } from "../clients/meteora.js";
import { log } from "../log.js";
import type { PoolStateSource } from "../poolState.js";

/** Minimum pool TVL (USD) to consider for the watchlist. */
const MIN_TVL_USD = 5_000;
/** Refresh on-chain fee params at most this often per pool. */
const PARAMS_TTL_MS = 24 * 3600 * 1000;

export interface DiscoveryDeps {
  db: Db;
  datapi: MeteoraDatapi;
  poolState: PoolStateSource;
  watchlistSize: number;
  /** always-watchlisted pool addresses (env pins + open validation positions) */
  pinned: () => Promise<string[]>;
}

function eligible(p: DatapiPool): boolean {
  return (
    !p.is_blacklisted &&
    p.token_y.address === SOL_MINT &&
    p.tvl >= MIN_TVL_USD &&
    (p.volume["1h"] ?? 0) > 0
  );
}

async function upsertFromDatapi(db: Db, p: DatapiPool): Promise<void> {
  await upsertPool(db, {
    address: p.address,
    tokenXMint: p.token_x.address,
    tokenYMint: p.token_y.address,
    tokenXSymbol: p.token_x.symbol,
    tokenYSymbol: p.token_y.symbol,
    tokenXDecimals: p.token_x.decimals,
    tokenYDecimals: p.token_y.decimals,
    binStep: p.pool_config.bin_step,
    raw: p,
  });
}

/**
 * One discovery round: pull top pools from datapi, rank SOL-quoted candidates
 * by GeekLad min projection, and reconcile the watchlist (pins always kept).
 */
export async function runDiscovery(deps: DiscoveryDeps): Promise<string[]> {
  const { db, datapi } = deps;

  const pages = await Promise.all([
    datapi.listPools({ page: 1, pageSize: 100, sortBy: "volume_24h:desc" }),
    datapi.listPools({ page: 1, pageSize: 100, sortBy: "fee_1h:desc" }),
  ]);
  const seen = new Map<string, DatapiPool>();
  for (const page of pages) {
    for (const p of page.data) seen.set(p.address, p);
  }

  const candidates = [...seen.values()].filter(eligible);
  const ranked = candidates
    .map((p) => ({
      pool: p,
      score: geekladEstimate({ feeTvlRatio: p.fee_tvl_ratio, volume: p.volume }).minProjection ?? 0,
    }))
    .sort((a, b) => b.score - a.score);

  const pinned = await deps.pinned();
  const selected = new Set<string>(pinned);
  for (const { pool } of ranked) {
    if (selected.size >= deps.watchlistSize + pinned.length) break;
    selected.add(pool.address);
  }

  // Upsert static rows for everything we saw (cheap, keeps pools table fresh).
  for (const p of seen.values()) await upsertFromDatapi(db, p);
  // Pinned pools may not appear in the top pages; fetch them directly.
  for (const addr of pinned) {
    if (!seen.has(addr)) {
      try {
        await upsertFromDatapi(db, await datapi.getPool(addr));
      } catch (err) {
        log.warn({ pool: addr, err: (err as Error).message }, "pinned pool not on datapi");
      }
    }
  }

  // Reconcile watchlist flags.
  const current = new Set((await getWatchlistedPools(db)).map((p) => p.address));
  for (const addr of current) {
    if (!selected.has(addr)) await setWatchlisted(db, addr, false);
  }
  const added: string[] = [];
  for (const addr of selected) {
    if ((await getPool(db, addr)) == null) {
      log.warn({ pool: addr }, "selected pool missing from pools table; skipping");
      continue;
    }
    if (!current.has(addr)) {
      await setWatchlisted(db, addr, true);
      added.push(addr);
    }
  }

  // On-chain fee params for watchlisted pools (new or stale).
  for (const addr of selected) {
    const row = await getPool(db, addr);
    if (!row) continue;
    const stale =
      row.base_factor == null ||
      row.params_updated_at == null ||
      Date.now() - row.params_updated_at.getTime() > PARAMS_TTL_MS;
    if (!stale) continue;
    try {
      await upsertPool(db, await deps.poolState.fetchStaticParams(addr));
    } catch (err) {
      log.warn({ pool: addr, err: (err as Error).message }, "on-chain param fetch failed");
    }
  }

  log.info(
    { watchlist: selected.size, added: added.length, candidates: candidates.length },
    "discovery round complete",
  );
  return [...selected];
}
