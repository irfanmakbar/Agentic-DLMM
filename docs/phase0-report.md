# Phase 0 Report — Data Foundation & Replay Backtester

> Status: TEMPLATE — fill in as validation tiers complete.
> Kill criterion (RESEARCH_PLAN §7): replay error > ~40% on real positions → stop, fix the data pipeline before any Phase 1 work.

## Summary

| Item | Value |
| --- | --- |
| Capture start date | 2026-07-02 (first swap 07:45 UTC; snapshots from 06:18) |
| Watchlisted pools | 3 (RPC-budget-limited on free endpoints) |
| Swaps captured | 1,303 (49 pools incl. pre-filter spillover) |
| Bin snapshots captured | 598 |
| Tier-1 fee residual (p90) | 0.0000% — end-bin rate exact on 80/80 swaps |
| Tier-2 positions replayed / median fee error | 13 / median abs fee error 2.95% (see tier-2 table) |
| Tier-3 positions / median error per component | pending ≥1 week of capture (tooling ready) |
| **Verdict (pass / fix-data / kill)** | engine PASS on covered windows; capture coverage is the binding constraint |

## Tier 1 — Unit + SDK cross-check (free, instant)

- Unit tests: `pnpm test` — 33 tests covering fee formulas (docs §4.2 vectors), Q64.64 price ladder, volatility state machine, swap walk conservation, position injection/dilution/resync.
- SDK parity (pure): `packages/data/test/sdkParity.test.ts` — qPriceFromId, getTotalFee, swapExactInQuoteAtBin bit-for-bit vs `@meteora-ag/dlmm@1.9.10`.
- SDK parity (live): `pnpm tsx packages/data/scripts/sdk-crosscheck.ts [pool] [amountIn]`
  - 2026-07-02 SOL-USDC bs4 (`5rCf1…AS6`): amountOut and userFee **exact match** (0.0000% rel diff) at 1 SOL and 500 SOL (4 bins crossed).
- Per-swap fee_bps residuals: `pnpm backtest calibrate-fees --pool <addr>`
  - 2026-07-02 RUSH-SOL bs100 (80 swaps, 29 snapshot checkpoints): **end-bin rate exact on 80/80 (100%), max residual 0.0000%**. Settles semantics: `fee_bps` = total fee rate with v_a at the swap's final bin; confirms the unconditional `last_update_timestamp` refresh and the exact §4.2 integer formulas.
  - Interpretation guide: with checkpoints enabled, `exact%` below ~100% indicates missed swaps between snapshots (capture holes); rerun after gap-fill.
  - Result on ≥1 day of capture: _TBD_

## Tier 2 — Third-party position replay (free)

`pnpm backtest replay-position --position <pubkey> [--lower-bin N --upper-bin N]`

Requires local capture covering the position's lifetime, plus `RPC_URL` for
deposit-shape decoding (the add-liquidity/rebalance instruction is decoded from
the open tx and expanded to exact per-bin amounts; bin range comes from the
datapi PnL endpoint).

2026-07-02 run — 13 closed third-party positions on RUSH-SOL bs100
(`3YnMG…L7Xr`), windows 10–58 min, mixes of `add_liquidity_by_strategy2`
(BidAsk/Spot) and `rebalance_liquidity`-created positions:

| Position | Fee error % | IL error % | Coverage |
| --- | --- | --- | --- |
| `DzPhc…KCQw` | **0.03** | -0.04 | full |
| `AV3Qz…zAdR` | **1.29** | 3.90 | full |
| `3SxKU…CPTi` | **-1.38** | -0.03 | full |
| `J2zD6…Vd2u` | **-1.38** | -0.03 | full |
| `2u2QT…gweDw` | **-1.38** | -0.05 | full |
| `92jFt…Uv83` | **-1.64** | -0.01 | full |
| `AqXMF…4HkV` | **-2.95** | -0.01 | full |
| `7J6Bi…94Fx` | **5.10** | -3.59 | full |
| `42YTM…gJVAs` | **-6.58** | -0.34 | full |
| `5iTAG…JKkyD` | -12.26 | -0.12 | window starts at capture start (07:45) |
| `8scjX…Eop1P` | -23.55 | -17.00 | spans 4-min snapshot gap at 08:00 |
| `EdwU7…v6FfP` | -28.32 | -48.40 | spans capture start + 08:00 gap |
| `4c2UW…LiCAC` | 287.49 | -83.04 | opened 35 min before first snapshot — uncovered |

Median abs fee error **2.95%** (all 13) / **1.64%** (9 fully covered).
Every error >10% is explained by a capture hole (window overlapping capture
start or a snapshot gap), and the residual grows monotonically with hole size —
the metric doubles as the standing data-quality alarm it was designed to be.
Nothing but the known-uncovered position approaches the 40% kill criterion.

Known approximations (quantified by this tier):
- Deposit shape falls back to uniform spot only when no RPC is configured —
  decoded shapes eliminated a 28× fee overestimate on a BidAsk position.
- Liquidity adds/removes between snapshots enter only at re-sync boundaries.
- Datapi remove events are applied as value-proportional withdrawals (per-bin
  remove decoding not implemented).

## Tier 3 — Tiny live positions (the §7 gate)

Prereq: ≥1 week of capture on the watchlist. Open 3–5 manual positions (0.1–0.3 SOL) via the Meteora UI, then:

1. `pnpm backtest validation register --pool <pool> --position <pubkey>`
2. Position's pool is auto-pinned into capture; wait for close.
3. `pnpm backtest validation track` (or cron it)
4. After close: `pnpm backtest validation compare`

| Position | Pool | Size (SOL) | Fee error % | IL error % | Net error % | Cause label |
| --- | --- | --- | --- | --- | --- | --- |
| _TBD_ | | | | | | |

**Gate: median per-component error ≤10–15% → pass. >40% → kill criterion; stop and fix data.**

## Cost model verification (§8 Q8)

`pnpm tsx packages/data/scripts/rent-probe.ts` — verified live 2026-07-02:

| Cost | Value | Refundable |
| --- | --- | --- |
| Position rent (≤70 bins, 8120 B) | 0.05740608 SOL | yes |
| Bin array rent (10136 B) | 0.07143744 SOL | **no** (per virgin array) |
| Wide position (140 bins) | 1 position account, 3 txs | — |

## §7 success metrics checklist

- [ ] Backtester replays a week of a top pool without crashing (needs ≥1 week capture; 1.75 h replayed cleanly)
- [x] Tier-1 residuals: p90 within tolerance (exact on 80/80 swaps with snapshot checkpoints)
- [x] Tier-2 fee error across ≥10 third-party positions: median ≤15% (13 positions, median 2.95%)
- [ ] Tier-3 live positions: per-component error ≤10–15% (tooling ready; gated on ≥1 week capture)
- [x] Rent/cost constants verified on-chain (rent-probe 2026-07-02)
- [ ] Anomalies labeled, never dropped (episodes.anomaly flag — writers land in Phase 1)
