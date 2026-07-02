# Phase 0 Runbook

## One-time setup

```bash
cp .env.example .env         # set HELIUS_API_KEY (public RPC works but throttles hard)
pnpm install
pnpm db:up                   # postgres:16 in docker
pnpm db:migrate
```

## Data capture (leave running)

```bash
pnpm ingestd
```

What it does: pool discovery → watchlist (30 min cadence), metrics snapshots (60 s),
bin-liquidity snapshots ±70 bins (45 s), live swap tail via logsSubscribe, gap-fill
(2 min), 24 h backfill for fresh watchlist entries, failed-fetch retry (5 min).

Tuning via env: `RPC_RPS`, `WATCHLIST_SIZE`, `WATCH_POOLS` (comma-separated pins),
`BACKFILL_HOURS`, `BIN_SNAPSHOT_INTERVAL_MS`, `SNAPSHOT_BINS_PER_SIDE`.

On the keyless public RPC use conservative settings, e.g.:

```bash
RPC_RPS=4 WATCHLIST_SIZE=3 BACKFILL_HOURS=0 pnpm ingestd
```

Health checks:

```bash
docker exec agentic-dlmm-pg psql -U dlmm -d dlmm -c \
  "select pool, count(*), max(block_ts) from swaps group by pool order by 2 desc"
docker exec agentic-dlmm-pg psql -U dlmm -d dlmm -c \
  "select pool, count(*), max(ts) from bin_snapshots group by pool"
```

## Tests + SDK cross-check (tier 1)

```bash
pnpm test                                            # unit + pure SDK parity
pnpm tsx packages/data/scripts/sdk-crosscheck.ts     # live quote parity
pnpm backtest calibrate-fees --pool <addr>           # fee_bps residual report
```

## Backtest a hypothetical position

```bash
pnpm backtest replay --pool <addr> \
  --from 2026-07-02T12:00:00Z --to 2026-07-02T18:00:00Z \
  --value-sol 0.5 --bins-below 10 --bins-above 10
```

Output: fees − IL vs HODL − swap costs − tx fees − binArray rent = net (SOL),
plus HODL benchmark and replay diagnostics (end-bin mismatches ≈ data quality).

## Third-party position replay (tier 2)

Find a recently closed position on a captured pool (Meteora UI / datapi), then:

```bash
RPC_URL=<rpc> pnpm backtest replay-position --position <pubkey>
```

With `RPC_URL` (or `HELIUS_API_KEY`) set, the open transaction is fetched and
the add-liquidity / rebalance instruction decoded into exact per-bin deposit
amounts (spot/curve/bidask shapes). Without it the deposit falls back to a
uniform spread over the datapi bin range — expect large fee errors on
BidAsk-shaped positions. Bulk candidates:

```bash
docker exec agentic-dlmm-pg psql -U dlmm -d dlmm -c "
  select position, min(block_ts) as opened, max(block_ts) as closed
  from liquidity_events where position is not null
  group by position
  having bool_or(kind='claim_fee') and max(block_ts) filter (where kind='position_close') is not null
  order by closed desc limit 20"
```

## Live validation positions (tier 3)

```bash
pnpm backtest validation register --pool <pool> --position <pubkey>
pnpm backtest validation track      # repeat until closed (or cron)
pnpm backtest validation compare    # writes errors into validation_positions
```

Record results in `docs/phase0-report.md`. Kill criterion: error > 40%.

## Rent probe

```bash
pnpm tsx packages/data/scripts/rent-probe.ts
```
