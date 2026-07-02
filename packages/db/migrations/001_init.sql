-- Phase 0 schema. Append-only, point-in-time correct (RESEARCH_PLAN.md §6.2).
-- Raw on-chain token amounts are NUMERIC (u64/u128 exceed int8). SOL-denominated
-- analytics values are double precision.

create table configs (
  theta_hash text primary key,
  version    int not null,
  config     jsonb not null,
  created_at timestamptz not null default now()
);

create table pools (
  address                    text primary key,
  token_x_mint               text not null,
  token_y_mint               text not null,
  token_x_symbol             text,
  token_y_symbol             text,
  token_x_decimals           int,
  token_y_decimals           int,
  bin_step                   int not null,
  -- static fee parameters (sParameters on the LbPair account)
  base_factor                int,
  base_fee_power_factor      int,
  variable_fee_control       bigint,
  filter_period              int,
  decay_period               int,
  reduction_factor           int,
  max_volatility_accumulator bigint,
  protocol_share             int,
  pair_type                  text,
  collect_fee_mode           text,
  supports_limit_order       boolean,
  watchlisted                boolean not null default false,
  watchlisted_at             timestamptz,
  first_seen_at              timestamptz not null default now(),
  params_updated_at          timestamptz,
  raw                        jsonb
);

create index pools_watchlisted_idx on pools (watchlisted) where watchlisted;

-- Point-in-time screening snapshots (feature source for decisions later).
create table pool_metrics (
  id                    bigserial primary key,
  pool                  text not null references pools(address),
  ts                    timestamptz not null,
  price                 double precision,
  active_bin            int,
  tvl                   double precision,
  mcap                  double precision,
  holders               int,
  organic_score         double precision,
  -- windows as served by dlmm.datapi.meteora.ag
  vol_30m               double precision,
  vol_1h                double precision,
  vol_2h                double precision,
  vol_4h                double precision,
  vol_12h               double precision,
  vol_24h               double precision,
  fees_30m              double precision,
  fees_1h               double precision,
  fees_2h               double precision,
  fees_4h               double precision,
  fees_12h              double precision,
  fees_24h              double precision,
  -- tx count over trailing 5 minutes, computed from our own swap capture
  tx_5m                 int,
  feetvl_proj_30m       double precision,
  feetvl_proj_1h        double precision,
  feetvl_proj_2h        double precision,
  feetvl_proj_4h        double precision,
  feetvl_proj_12h       double precision,
  feetvl_proj_24h       double precision,
  feetvl_min_projection double precision,
  volume_uptrend        boolean,
  sol_usd               double precision,
  raw                   jsonb
);

create index pool_metrics_pool_ts_idx on pool_metrics (pool, ts);

-- One row per Swap2Evt (fallback: Swap) event.
create table swaps (
  sig             text not null,
  event_ordinal   int not null,
  pool            text not null,
  slot            bigint not null,
  block_ts        timestamptz not null,
  swap_for_y      boolean not null,
  start_bin       int not null,
  end_bin         int not null,
  amount_in       numeric not null,
  amount_out      numeric not null,
  -- on-chain field name; actually the total fee RATE in 1e9 precision
  -- (FEE_PRECISION), e.g. 403133 = 0.0403%. Max 1e8 (10%).
  fee_bps         int,
  fee             numeric,
  mm_fee          numeric,
  protocol_fee    numeric,
  limit_order_fee numeric,
  host_fee        numeric,
  fees_on_input   boolean,
  fees_on_token_x boolean,
  raw             jsonb,
  primary key (sig, event_ordinal)
);

create index swaps_pool_slot_idx on swaps (pool, slot, event_ordinal);
create index swaps_pool_ts_idx on swaps (pool, block_ts);

-- AddLiquidity / RemoveLiquidity / Rebalancing / PositionCreate / PositionClose /
-- ClaimFee(2) / CompositionFee events for watchlisted pools.
create table liquidity_events (
  sig           text not null,
  event_ordinal int not null,
  pool          text not null,
  kind          text not null,
  position      text,
  owner         text,
  slot          bigint not null,
  block_ts      timestamptz not null,
  amount_x      numeric,
  amount_y      numeric,
  active_bin    int,
  raw           jsonb,
  primary key (sig, event_ordinal)
);

create index liquidity_events_pool_ts_idx on liquidity_events (pool, block_ts);
create index liquidity_events_position_idx on liquidity_events (position);

-- Periodic per-pool bin-liquidity snapshots around the active bin.
-- bins: [{i, x, y, s, p}] = binId, raw X amount, raw Y amount, liquidity share
-- supply, price (per-lamport). Optional lo/loAsk for limit-order liquidity.
create table bin_snapshots (
  id         bigserial primary key,
  pool       text not null,
  ts         timestamptz not null,
  slot       bigint,
  active_bin int not null,
  -- live volatility state at snapshot time (vParameters), for fee-sim warmup checks
  v_acc      bigint,
  v_ref      bigint,
  idx_ref    int,
  last_update_ts bigint,
  bins       jsonb not null
);

create index bin_snapshots_pool_ts_idx on bin_snapshots (pool, ts);

-- Every decision records the exact feature snapshot it acted on (writers arrive Phase 1).
create table decisions (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  instance_id text not null,
  theta_hash  text references configs(theta_hash),
  pool        text,
  action      text not null,
  features    jsonb not null,
  propensity  double precision,
  notes       text
);

create index decisions_instance_ts_idx on decisions (instance_id, ts);

create type cause_label as enum (
  'rug', 'trended_out_below', 'trended_out_above', 'vol_collapse', 'chop_grind',
  'dead_pool_rotation', 'tp', 'trailing_tp', 'sl', 'manual', 'other'
);

-- Episode = one position open->close; the atomic learning unit.
-- net_pnl_sol = fees_claimed - il_vs_hodl - rebalance_realized_loss - swap_costs
--             - tx_fees - rent_nonrefundable  (all SOL).
create table episodes (
  id                          bigserial primary key,
  instance_id                 text not null,
  theta_hash                  text,
  pool                        text not null,
  position_pubkey             text unique,
  open_ts                     timestamptz not null,
  close_ts                    timestamptz,
  open_sig                    text,
  close_sig                   text,
  deposit_x                   numeric,
  deposit_y                   numeric,
  deposit_sol                 double precision,
  fees_claimed_sol            double precision,
  il_vs_hodl_sol              double precision,
  rebalance_realized_loss_sol double precision,
  swap_costs_sol              double precision,
  tx_fees_sol                 double precision,
  rent_nonrefundable_sol      double precision,
  net_pnl_sol                 double precision,
  hodl_benchmark_sol          double precision,
  ref_config_benchmark_sol    double precision,
  cause                       cause_label,
  cause_source                text,
  anomaly                     boolean not null default false,
  anomaly_note                text,
  raw                         jsonb
);

create index episodes_instance_idx on episodes (instance_id, open_ts);

-- Phase 0 backtester validation: tiny real positions, predicted vs realized.
create table validation_positions (
  id              bigserial primary key,
  pool            text not null,
  position_pubkey text not null unique,
  wallet          text,
  open_sig        text,
  close_sig       text,
  open_ts         timestamptz,
  close_ts        timestamptz,
  status          text not null default 'open',
  predicted       jsonb,
  realized        jsonb,
  fee_error_pct   double precision,
  il_error_pct    double precision,
  net_error_pct   double precision,
  notes           text
);

-- Transaction-level idempotency: a tx may involve several pools (aggregator
-- routes); it is decoded exactly once and all its events stored.
-- slot null = fetch failed (candidate for retry); pool = capture context.
create table processed_txs (
  sig          text primary key,
  slot         bigint,
  pool         text,
  processed_at timestamptz not null default now()
);

create index processed_txs_failed_idx on processed_txs (processed_at) where slot is null;

-- Signature-capture progress per pool (live tail + backfill bookkeeping).
create table ingest_cursors (
  pool              text primary key,
  newest_sig        text,
  newest_slot       bigint,
  oldest_sig        text,
  oldest_slot       bigint,
  backfill_complete boolean not null default false,
  updated_at        timestamptz not null default now()
);
