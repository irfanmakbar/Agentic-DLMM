# Agentic DLMM — Project Brief

Self-learning, multi-instance LP agent fleet for Meteora DLMM on Solana. Owner: Irfan. Inspiration: yunus-0x/meridian (see `mem:meridian-teardown`). Prior attempt with Gemini-as-decision-maker consistently lost money — root cause is architectural, not model choice (see `mem:learning-architecture`).

**Master document:** `RESEARCH_PLAN.md` at repo root (v1, 2026-07-02) — full hand-off research/build plan with phases, architecture, risk register, sources.

**Core architecture decision (non-negotiable):** three-loop design —
1. Inner loop: deterministic parameterized policy (config vector θ), zero LLM at decision time, rule-based Guardian with veto on every tx.
2. Middle loop: statistical learning — HMM regime detection, walk-forward TPE/evolutionary optimization over a replay backtester, gradient-boosted enter/skip classifier, risk-aware Thompson-sampling capital allocation across the fleet.
3. Outer loop: LLM (Claude) as analyst/hypothesis-generator/config-mutator/safety-classifier only; every proposal passes backtest → shadow ≥1-2 weeks → small live allocation.

**"Self-learning" =** decomposed PnL on every closed position (fees − IL_vs_HODL − rebalance loss − tx/rent costs, SOL-denominated) + cause labels (rug / trended_out / chop_grind / dead_pool / tp / sl), consumed by per-regime refits, bandit reallocation, and LLM-driven config evolution.

**Fleet:** 10–20 live instances with different θ + 2–4× shadow instances; allocation floors 2–5%, caps ~25%, drawdown embargo; judge nothing on <30–50 episodes.

**Phases:** 0 data+replay-backtester (kill criterion: replay error >40% → stop) → 1 deterministic baseline (frozen forever as control) → 2 attribution → 3 statistical learning → 4 LLM outer loop → 5 scale.

Related: `mem:dlmm-mechanics`, `mem:community-strategy-meta`.