import { RateLimiter, fetchJson } from "../rateLimiter.js";

const BASE_URL = "https://dlmm.datapi.meteora.ag";

/** Windows served by the datapi volume/fees/fee_tvl_ratio objects. */
export type DatapiWindow = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export interface DatapiToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders: number | null;
  total_supply: number | null;
  price: number | null;
  market_cap: number | null;
}

export interface DatapiPool {
  address: string;
  name: string;
  token_x: DatapiToken;
  token_y: DatapiToken;
  token_x_amount: number;
  token_y_amount: number;
  created_at: number;
  pool_config: {
    bin_step: number;
    base_fee_pct: number;
    max_fee_pct: number;
    protocol_fee_pct: number;
    collect_fee_mode: number;
  };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  volume: Partial<Record<DatapiWindow, number>>;
  fees: Partial<Record<DatapiWindow, number>>;
  fee_tvl_ratio: Partial<Record<DatapiWindow, number>>;
  cumulative_metrics: { volume: number; fees: number };
  is_blacklisted: boolean;
  launchpad: string;
  tags: string[];
}

export interface DatapiPoolsPage {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: DatapiPool[];
}

export interface PositionPnlData {
  positionAddress: string;
  minPrice: string;
  maxPrice: string;
  lowerBinId: number;
  upperBinId: number;
  isClosed: boolean;
  createdAt: number | null;
  closedAt: number | null;
  pnlUsd: string;
  pnlSol: number | null;
  allTimeDeposits: TokenPairWithTotal;
  allTimeWithdrawals: TokenPairWithTotal;
  allTimeFees: TokenPairWithTotal;
}

export interface TokenPairWithTotal {
  tokenX: { amount: string; amountSol: string | null; usd: string };
  tokenY: { amount: string; amountSol: string | null; usd: string };
  total: { usd: string; sol: string | null };
}

export interface PositionPnlResponse {
  totalCount: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  positions: PositionPnlData[];
  tokenXPrice: string;
  tokenYPrice: string;
  solPrice: string | null;
}

export interface PositionEvent {
  signature: string;
  ixIndex: number;
  eventType: "add" | "remove" | "claim_fee" | "claim_reward";
  positionAddress: string;
  /** milliseconds since epoch (observed live; not seconds) */
  blockTime: number;
  slot: number;
  poolAddress: string;
  userAddress: string;
  tokenX: string;
  tokenY: string;
  /** UI decimal string, e.g. "0.999999964" — NOT raw integer units */
  amountX: string;
  amountY: string;
  amountXUsd: string;
  amountYUsd: string;
  totalUsd: string;
}

/** Keyless, rate-limited at 30 req/s; we stay below it. */
export class MeteoraDatapi {
  private readonly limiter: RateLimiter;

  constructor(ratePerSec = 20) {
    this.limiter = new RateLimiter(ratePerSec);
  }

  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    await this.limiter.acquire();
    const url = new URL(path, BASE_URL);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return fetchJson<T>(url.toString());
  }

  /** sortBy e.g. "volume_24h:desc", "fees_1h:desc", "tvl:desc". filterBy passed verbatim. */
  listPools(opts: {
    page?: number;
    pageSize?: number;
    sortBy?: string;
    filterBy?: string;
    query?: string;
  } = {}): Promise<DatapiPoolsPage> {
    return this.get<DatapiPoolsPage>("/pools", {
      page: opts.page ?? 1,
      page_size: opts.pageSize ?? 50,
      sort_by: opts.sortBy,
      filter_by: opts.filterBy,
      query: opts.query,
    });
  }

  getPool(address: string): Promise<DatapiPool> {
    return this.get<DatapiPool>(`/pools/${address}`);
  }

  getPositionPnl(
    poolAddress: string,
    user: string,
    status: "open" | "closed" | "all" = "all",
    page = 1,
    pageSize = 100,
  ): Promise<PositionPnlResponse> {
    return this.get<PositionPnlResponse>(`/positions/${poolAddress}/pnl`, {
      user,
      status,
      page,
      page_size: pageSize,
    });
  }

  async getPositionHistoricalEvents(
    positionAddress: string,
    eventType?: PositionEvent["eventType"],
  ): Promise<PositionEvent[]> {
    const res = await this.get<{ events: PositionEvent[] }>(`/positions/${positionAddress}/historical`, {
      event_type: eventType,
      order_direction: "asc",
    });
    return res.events;
  }
}
