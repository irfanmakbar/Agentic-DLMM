import { geekladEstimate } from "@agentic-dlmm/core";
import { type Db, getWatchlistedPools, insertPoolMetrics } from "@agentic-dlmm/db";
import type { JupiterClient, JupiterTokenInfo } from "../clients/jupiter.js";
import type { MeteoraDatapi } from "../clients/meteora.js";
import { log } from "../log.js";

const TOKEN_INFO_TTL_MS = 5 * 60 * 1000;

interface CachedTokenInfo {
  at: number;
  info: JupiterTokenInfo | null;
}

export class MetricsSnapshotter {
  private readonly tokenCache = new Map<string, CachedTokenInfo>();

  constructor(
    private readonly db: Db,
    private readonly datapi: MeteoraDatapi,
    private readonly jupiter: JupiterClient,
  ) {}

  private async tokenInfo(mint: string): Promise<JupiterTokenInfo | null> {
    const cached = this.tokenCache.get(mint);
    if (cached && Date.now() - cached.at < TOKEN_INFO_TTL_MS) return cached.info;
    let info: JupiterTokenInfo | null = null;
    try {
      info = await this.jupiter.searchToken(mint);
    } catch (err) {
      log.warn({ mint, err: (err as Error).message }, "jupiter token lookup failed");
    }
    this.tokenCache.set(mint, { at: Date.now(), info });
    return info;
  }

  async run(): Promise<void> {
    const pools = await getWatchlistedPools(this.db);
    if (pools.length === 0) return;
    let solUsd: number | null = null;
    try {
      solUsd = await this.jupiter.getSolUsd();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "sol price fetch failed");
    }

    for (const pool of pools) {
      try {
        const detail = await this.datapi.getPool(pool.address);
        const est = geekladEstimate({ feeTvlRatio: detail.fee_tvl_ratio, volume: detail.volume });
        const tokenInfo = await this.tokenInfo(pool.token_x_mint);
        const { rows } = await this.db.query<{ n: string }>(
          "select count(*) n from swaps where pool = $1 and block_ts > now() - interval '5 minutes'",
          [pool.address],
        );
        await insertPoolMetrics(this.db, {
          pool: pool.address,
          ts: new Date(),
          price: detail.current_price,
          activeBin: null, // captured by bin snapshots
          tvl: detail.tvl,
          mcap: tokenInfo?.mcap ?? detail.token_x.market_cap,
          holders: tokenInfo?.holderCount ?? detail.token_x.holders,
          organicScore: tokenInfo?.organicScore ?? null,
          volumes: detail.volume,
          fees: detail.fees,
          tx5m: Number(rows[0]?.n ?? 0),
          feeTvlProjections: est.projections,
          feetvlMinProjection: est.minProjection,
          volumeUptrend: est.volumeUptrend,
          solUsd,
          raw: { dynamic_fee_pct: detail.dynamic_fee_pct, cumulative: detail.cumulative_metrics },
        });
      } catch (err) {
        log.warn({ pool: pool.address, err: (err as Error).message }, "metrics snapshot failed");
      }
    }
    log.debug({ pools: pools.length }, "metrics round complete");
  }
}
