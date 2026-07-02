// Row shapes as returned by pg: NUMERIC columns come back as strings,
// BIGINT columns as strings (pg default) unless small enough via int8 parser.
// We register no custom parsers; amounts stay strings until the consumer
// converts (backtester uses bigint).

export interface PoolRow {
  address: string;
  token_x_mint: string;
  token_y_mint: string;
  token_x_symbol: string | null;
  token_y_symbol: string | null;
  token_x_decimals: number | null;
  token_y_decimals: number | null;
  bin_step: number;
  base_factor: number | null;
  base_fee_power_factor: number | null;
  variable_fee_control: string | null;
  filter_period: number | null;
  decay_period: number | null;
  reduction_factor: number | null;
  max_volatility_accumulator: string | null;
  protocol_share: number | null;
  pair_type: string | null;
  collect_fee_mode: string | null;
  supports_limit_order: boolean | null;
  watchlisted: boolean;
  watchlisted_at: Date | null;
  first_seen_at: Date;
  params_updated_at: Date | null;
  raw: unknown;
}

export interface SwapRow {
  sig: string;
  event_ordinal: number;
  pool: string;
  slot: string;
  block_ts: Date;
  swap_for_y: boolean;
  start_bin: number;
  end_bin: number;
  amount_in: string;
  amount_out: string;
  fee_bps: number | null;
  fee: string | null;
  mm_fee: string | null;
  protocol_fee: string | null;
  limit_order_fee: string | null;
  host_fee: string | null;
  fees_on_input: boolean | null;
  fees_on_token_x: boolean | null;
  raw: unknown;
}

export interface LiquidityEventRow {
  sig: string;
  event_ordinal: number;
  pool: string;
  kind: string;
  position: string | null;
  owner: string | null;
  slot: string;
  block_ts: Date;
  amount_x: string | null;
  amount_y: string | null;
  active_bin: number | null;
  raw: unknown;
}

/** One bin inside a bin_snapshots row. Raw integer amounts as strings. */
export interface SnapshotBin {
  i: number;
  x: string;
  y: string;
  s: string;
  /** limit-order liquidity (openOrder + processedOrderRemaining), if any */
  lo?: string;
  loAsk?: boolean;
}

export interface BinSnapshotRow {
  id: string;
  pool: string;
  ts: Date;
  slot: string | null;
  active_bin: number;
  v_acc: string | null;
  v_ref: string | null;
  idx_ref: number | null;
  last_update_ts: string | null;
  bins: SnapshotBin[];
}

export interface ValidationPositionRow {
  id: string;
  pool: string;
  position_pubkey: string;
  wallet: string | null;
  open_sig: string | null;
  close_sig: string | null;
  open_ts: Date | null;
  close_ts: Date | null;
  status: string;
  predicted: unknown;
  realized: unknown;
  fee_error_pct: number | null;
  il_error_pct: number | null;
  net_error_pct: number | null;
  notes: string | null;
}

export interface IngestCursorRow {
  pool: string;
  newest_sig: string | null;
  newest_slot: string | null;
  oldest_sig: string | null;
  oldest_slot: string | null;
  backfill_complete: boolean;
  updated_at: Date;
}

export interface NewSwap {
  sig: string;
  eventOrdinal: number;
  pool: string;
  slot: number;
  blockTs: Date;
  swapForY: boolean;
  startBin: number;
  endBin: number;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: number | null;
  fee: bigint | null;
  mmFee: bigint | null;
  protocolFee: bigint | null;
  limitOrderFee: bigint | null;
  hostFee: bigint | null;
  feesOnInput: boolean | null;
  feesOnTokenX: boolean | null;
  raw?: unknown;
}

export interface NewLiquidityEvent {
  sig: string;
  eventOrdinal: number;
  pool: string;
  kind: string;
  position: string | null;
  owner: string | null;
  slot: number;
  blockTs: Date;
  amountX: bigint | null;
  amountY: bigint | null;
  activeBin: number | null;
  raw?: unknown;
}

export interface NewBinSnapshot {
  pool: string;
  ts: Date;
  slot: number | null;
  activeBin: number;
  vAcc: bigint | null;
  vRef: bigint | null;
  idxRef: number | null;
  lastUpdateTs: bigint | null;
  bins: SnapshotBin[];
}

export interface NewPoolMetrics {
  pool: string;
  ts: Date;
  price: number | null;
  activeBin: number | null;
  tvl: number | null;
  mcap: number | null;
  holders: number | null;
  organicScore: number | null;
  /** volumes/fees keyed by datapi window name: 30m, 1h, 2h, 4h, 12h, 24h */
  volumes: Partial<Record<MetricsWindow, number>>;
  fees: Partial<Record<MetricsWindow, number>>;
  tx5m: number | null;
  feeTvlProjections: Partial<Record<MetricsWindow, number>>;
  feetvlMinProjection: number | null;
  volumeUptrend: boolean | null;
  solUsd: number | null;
  raw?: unknown;
}

export type MetricsWindow = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export interface NewPool {
  address: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXSymbol?: string | null;
  tokenYSymbol?: string | null;
  tokenXDecimals?: number | null;
  tokenYDecimals?: number | null;
  binStep: number;
  baseFactor?: number | null;
  baseFeePowerFactor?: number | null;
  variableFeeControl?: bigint | null;
  filterPeriod?: number | null;
  decayPeriod?: number | null;
  reductionFactor?: number | null;
  maxVolatilityAccumulator?: bigint | null;
  protocolShare?: number | null;
  pairType?: string | null;
  collectFeeMode?: string | null;
  supportsLimitOrder?: boolean | null;
  raw?: unknown;
}
