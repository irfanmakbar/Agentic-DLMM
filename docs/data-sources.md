# Data-source inventory

Verified 2026-07-02 by live probes. Re-verify anything here older than ~1 month before building on it (RESEARCH_PLAN.md §11).

## Meteora DLMM Data API — `https://dlmm.datapi.meteora.ag`

Keyless, rate limit 30 req/s (we self-limit to 20). Windows served for volume/fees/fee_tvl_ratio: **30m, 1h, 2h, 4h, 12h, 24h** (note: not 5m/6h as older references say — the GeekLad estimator here uses the served windows).

| Endpoint | Use |
|---|---|
| `GET /pools?page&page_size&sort_by&filter_by&query` | discovery + screening (page is 1-based; `sort_by` like `volume_24h:desc`) |
| `GET /pools/{address}` | pool detail: tvl, `pool_config` (bin_step, base_fee_pct, collect_fee_mode), `dynamic_fee_pct`, volume/fees per window, `cumulative_metrics` (lifetime fees — GMGN substitute), token holders/mcap |
| `GET /pools/{address}/ohlcv`, `/volume/history` | charts/context (not load-bearing in Phase 0) |
| `GET /positions/{pool}/pnl?user&status&page` | per-position all-time deposits/withdrawals/**fees** incl. SOL denomination — tier-2 validation ground truth |
| `GET /positions/{address}/historical?event_type&order_direction` | add/remove/claim_fee/claim_reward events with amounts, sig, slot — position reconstruction |

Pool-discovery host `pool-discovery-api.datapi.meteora.ag` responds 200 but the main datapi `/pools` covers discovery needs; we use the latter.

## Helius (RPC + WebSocket) — free-tier compatible

- `getSignaturesForAddress` + `getTransaction` (jsonParsed, `maxSupportedTransactionVersion: 0`) — backfill + gap-fill per watchlisted pool.
- `logsSubscribe` (`mentions: [pool]`) — live tail trigger; the tx is then fetched and events decoded from **Anchor event CPI inner instructions** (lb_clmm emits via `emit_cpi`, not logs).
- Account reads: `LbPair` (active bin, `vParameters`/`sParameters`), bin arrays via SDK `getBinsAroundActiveBin`.
- Self-limited to `RPC_RPS` (default 8) to fit the free tier; raise via env with a paid plan. Upgrade path: `transactionSubscribe` (Developer+), LaserStream gRPC (Business+) behind the same `SignatureSource` interface.

## Jupiter — price + token metadata

- Keyless host `lite-api.jup.ag` (~1 rps), with key `api.jup.ag` (header `x-api-key`).
- `GET /price/v3?ids=<mints>` (≤50 mints) — SOL/USD conversion and external price sanity (Guardian oracle later).
- `GET /tokens/v2/search?query=<mint>` — `holderCount`, `organicScore` (0–100), `audit` flags. Verified live: SOL returns organicScore ≈ 99.

## GMGN — not used in v0

API is application-gated (Ed25519 key + approval at gmgn.ai/ai, 2 req/s). The Meridian "lifetime fees ≥ 30 SOL (GMGN)" filter is approximated with `cumulative_metrics.fees` (USD) from the Meteora pool detail — **unverified as an exact substitute**; revisit if screening quality suffers.

## On-chain program

`lb_clmm` program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, SDK `@meteora-ag/dlmm@1.9.10` (pinned exact; ESM build is broken — load via CJS `createRequire`). Events used: `Swap2Evt` (rich fee decomposition; `Swap` kept as fallback), `AddLiquidity`, `RemoveLiquidity`, `Rebalancing`, `PositionCreate`, `PositionClose`, `ClaimFee`/`ClaimFee2`, `CompositionFee`.

Rent constants from SDK v1.9.10 (re-verify with `pnpm backtest rent-probe`): position 0.05740608 SOL (refundable), binArray 0.07143744 SOL (non-refundable), bitmap extension 0.01180416 SOL.
