# agentic-dlmm

Self-learning, multi-instance liquidity-provision agent fleet for Meteora DLMM on Solana.

**Master document:** [`RESEARCH_PLAN.md`](RESEARCH_PLAN.md). **Current phase:** Phase 0 — data foundation + replay backtester (no strategies, no LLM layer, no automated trading yet).

## Architecture (Phase 0 slice)

- `packages/core` — pure math shared by replay and (later) execution: bin price ladder, constant-sum swap walk, dynamic-fee state machine (exact `lb_clmm` integer formulas), GeekLad min-projection fee/TVL estimator, SOL-denomination helpers. No I/O.
- `packages/db` — Postgres schema (append-only, point-in-time correct) + migration runner + typed query layer.
- `packages/data` — Meteora data-API and Jupiter clients, Helius swap capture (backfill + live tail + gap-fill), Anchor event decoder, pool discovery → watchlist, metrics + bin-liquidity snapshotters. Daemon entry: `ingestd`.
- `packages/backtester` — replay engine (bin-state reconstruction, hypothetical-position injection with fee-share dilution, IL vs HODL, full cost model), calibration + validation harness. CLI entry: `backtest`.
- `research/` — Python notebooks for estimator cross-checks and replay-error analysis.
- `docs/` — data-source inventory, Phase 0 report + runbook.

## Setup

```bash
pnpm install
cp .env.example .env          # fill HELIUS_API_KEY
pnpm db:up                    # postgres:16 via docker compose
pnpm db:migrate
```

## Run

```bash
pnpm ingestd                  # discovery + snapshots + swap capture
pnpm backtest -- --help       # replay / calibrate / validate commands
pnpm test                     # unit tests
pnpm typecheck
```

## Hard rules (never relax; see RESEARCH_PLAN.md §1)

1. No LLM call in any per-tick/per-transaction decision path.
2. Nothing reaches live capital without replay backtest → shadow → small allocation.
3. Guardian is immutable code with final veto (arrives Phase 1).
4. All accounting SOL-denominated, benchmarked vs HODL-SOL.
5. Point-in-time logging — never reconstruct features after the fact.
6. Judge nothing on fewer than 30–50 episodes; keep every episode.

## Phase 0 kill criterion

Validate the backtester against a handful of tiny real positions. If replay error exceeds ~40%, **stop and fix the data pipeline** before any strategy work. Target ≤10–15%. See `docs/phase0-report.md`.
