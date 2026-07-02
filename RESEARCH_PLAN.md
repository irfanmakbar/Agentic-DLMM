# Agentic DLMM — Research & Build Plan

**Project:** `agentic-dlmm` — a self-learning, multi-instance liquidity-provision agent fleet for Meteora DLMM on Solana.
**Status:** Research plan (v1, 2026-07-02). Written to be handed to a research/build AI as a self-contained brief.
**Prior attempt:** A Gemini-as-backbone trading bot that consistently lost money. This plan explains why that happened and designs around it.

---

## 0. Executive summary

Every serious 2025–2026 evaluation of LLM-as-trading-decision-maker converges on the same result: they lose money (Alpha Arena: 4 of 6 frontier models lost, Gemini 2.5 Pro −56.7%; "Profit Mirage" arXiv:2510.07920: LLM backtest alpha is mostly training-data memorization; FINSABER arXiv:2505.07078: "a consistent and statistically significant failure to generate alpha"). The Gemini failure was not a model-choice problem — it was an architecture problem.

**The design that the evidence supports is a three-loop architecture:**

1. **Inner loop (ms–seconds): deterministic parameterized policy.** Pure rules — screening filters, bin-range/shape selection, exits — evaluated against streamed pool state. Zero model inference at decision time. Every action passes a rule-based **Guardian** (exposure caps, sanity checks, kill-switch).
2. **Middle loop (hours–days): statistical learning.** Regime detection (HMM), per-regime parameter tables fit by walk-forward Bayesian/evolutionary optimization over a **replay backtester**, a supervised enter/skip classifier trained on our own closed positions, and **bandit capital allocation** across N differently-configured instances.
3. **Outer loop (days–weeks): LLM as analyst, never as trader.** The LLM reads decomposed PnL logs, proposes hypotheses and candidate configs, classifies token/rug risk into a bounded feature — and everything it proposes must pass backtest → shadow trading → small live allocation before touching real capital.

"Self-learning" is implemented as: **decomposed PnL attribution on every closed position** (fees earned − IL vs HODL − rebalance-realized loss − tx/rent costs, plus a cause label), which is exactly the "what aspect made us profit or lose" signal the project demands — and three mechanisms that consume it (per-regime parameter refits, bandit reallocation toward what's currently working, LLM-driven config evolution).

"Deployed multiple" is implemented as: a **fleet of 10–20 live instances** with different config vectors plus 2–4× as many shadow instances, with capital reallocated by risk-aware Thompson sampling (floors 2–5%, caps ~25%, drawdown embargo).

---

## 1. Mission, constraints, and definitions

**Mission:** a self-sustaining agent fleet that LPs on Meteora DLMM pools (primarily SOL-quoted memecoin pools, optionally majors), measured in **SOL terms**, that improves its own parameters from its own outcomes, and survives without daily human babysitting.

**Hard constraints (non-negotiable, learned from evidence in §2):**
- No LLM call in any per-tick or per-transaction decision path.
- No config reaches live capital without passing: replay backtest (walk-forward, all costs included) → shadow period → small allocation.
- Deterministic Guardian with final veto on every transaction; its rules are code, versioned, and not modifiable by any learning loop.
- All accounting SOL-denominated; benchmark every position against "just held SOL."
- Point-in-time feature logging: every decision logs the exact features it saw. Never recompute features from history afterward.

**Definitions:**
- *Episode* = one position from open to close, the atomic learning unit.
- *Config θ* = the full parameter vector defining one instance's behavior (§6.1).
- *Shadow instance* = runs the full decision loop against live data, logs everything, allocates zero capital.

---

## 2. Post-mortem: why the Gemini bot lost (and why any LLM-inner-loop bot loses)

Documented failure mechanisms, each with public evidence:

| # | Mechanism | Evidence |
|---|-----------|----------|
| 1 | **Over-trading → fee/cost bleed.** LLMs take quick tiny gains that costs erase. | nof1 Alpha Arena post-mortem: "PnL was dominated by trading costs as agents over-traded" |
| 2 | **Statelessness.** Each call re-evaluates a snapshot; no persistent calibrated beliefs; tiny input changes flip decisions. | AlphaForgeBench arXiv:2602.18481 |
| 3 | **Classification, not optimization.** Prompting for an action asks "what sounds reasonable," not "maximize return net of fees under inventory constraints." No real bankroll math. | AlphaForgeBench; FINSABER |
| 4 | **Backtest contamination.** LLM "alpha" evaporates ~50–72% when tested only on post-cutoff data. | "Profit Mirage" arXiv:2510.07920 |
| 5 | **Credulity & hallucinated state.** One bullish headline reshuffles a whole portfolio; agents fabricate market facts and trade on them confidently. | AI-Trader (HKU 2025); Guardian-pattern post-mortem (dev.to) |
| 6 | **Memory makes it worse.** Similarity-retrieved trade memories amplify overconfidence (retrieval surfaces past wins → "momentum works" prior). | S. Peng, "I Gave My Trading Agent Memory" |
| 7 | **Non-determinism.** Runs diverge even at temperature 0; single-run performance is statistically meaningless (n=1 over 2 weeks tells you nothing — evaluation itself is noise-dominated). | AlphaForgeBench App. C; Tseitlin's Alpha Arena critique |
| 8 | **Latency + per-call cost** vs a market that moves in milliseconds. | delomite, "The Stochastic Parrot" |

**Implication for evaluation design (not just trading design):** never judge a config from one instance-run. Require ≥30–50 closed episodes or a fixed shadow period before believing any performance number, including our own.

**What LLMs are evidenced to do well (outer loop only):**
- Hypothesis/config generation inside an evolutionary loop with a deterministic evaluator (FunSearch/AlphaEvolve pattern; QuantEvolve held-out Sharpe > 1.5; AlgoEvolve +23% Sharpe vs plain GP — arXiv:2409.06289, arXiv:2605.23007).
- Sentiment/narrative/token-safety classification as one bounded input feature (Lopez-Lira & Tang, arXiv:2306.14222).
- Writing new strategy-module code, human-reviewed and backtest-gated (QuantCode-Bench arXiv:2604.15151 — works, high variance).

---

## 3. Prior art: Meridian teardown (github.com/yunus-0x/meridian)

Real project by @0xyunss (Indonesian, MeteoraIDN/LP-Army community), ~15k LOC plain JS, 633 stars / 457 forks, created 2026-03, built largely with Claude Code. Author claims "$20+/day", "week 1: $593.56", 80–90% hit rate — **unverified, no on-chain track record published**. Its own bug history is instructive: a June 12 "PnL sanity gate" bug silently disabled stop-loss/trailing exits for ~2 weeks, and its "Degen Score" opportunity poller was dead-calibrated (read near-zero) for 3 months after launch.

### 3.1 What to keep (proven-shape ideas, adopt with modification)

| Meridian feature | Assessment |
|---|---|
| **Hard deterministic screening filters** before any LLM sees a pool: mcap $150k–$10M, holders ≥500, TVL $10k–$150k, fee/active-TVL ≥0.05, organic score ≥60, bin step 80–125, ≥30 SOL lifetime fees (GMGN), bot holders ≤30%, top-10 concentration ≤60%, launchpad/deployer blacklists, per-token cooldowns | Keep as **starting priors for θ**; these numbers are community-validated defaults |
| **Deterministic exit engine** (post-Jun-25 refactor, moved *out* of the LLM): stop-loss; TP ≥5%; pumped >10 bins above range; out-of-range-above ≥30 min; low fee-yield after 60 min; trailing TP arming at +3% peak, closing on −1.5% from confirmed peak | Keep; this is convergent evolution toward our architecture — they *removed* the LLM from exits because it didn't work |
| **3-second on-chain PnL poller** with 2-tick confirmation before firing exits | Keep the pattern |
| Single-sided SOL Bid-Ask ladder below active bin, volatility-scaled width (35–69 bins below) | Keep as **one** strategy in the population, not the only one |
| Mandatory base-token→SOL swap after every close; gas reserve; position-count cap | Keep |
| Decision log + per-pool memory | Keep the logging idea; replace the consumption mechanism |

### 3.2 What to fix (our differentiation)

1. **No backtesting/simulation** — all tuning is live-money trial and error. → Our Phase 0 builds a replay backtester *first*.
2. **n=1 "learning"** — templated text "lessons" from single closed positions with hand-invented confidence values, injected into prompts; "Darwinian signal weights" that only influence prose, not any numeric score; threshold evolution that nudges exactly 2 thresholds every 5 closes. → Replace with real statistics (§6).
3. **One-directional strategy only** (SOL bid ladder). Pump → sits 100% SOL earning nothing; dump → converts fully into a collapsing token with (config-default) **−50% stop-loss** as the only brake (README claims −15%; code says −50%). No rebalancing at all — just close-and-redeploy churn paying gas + swap fees every cycle. → Wider policy class incl. recentering via the new `rebalance_liquidity` instruction.
4. **HiveMind prompt-poisoning vector**: shared "lessons" from strangers' instances are pulled from the author's server into everyone's trading prompts, with no true off switch. → Never inject third-party free text into decision paths.
5. **Operational fragility**: flat JSON state re-read/written synchronously on every 3s tick, single process, no DB, positions-cache races. → Proper store (SQLite/Postgres), idempotent tx handling.
6. **Survivorship in its own data**: "suspicious" PnL records are skipped, not corrected → biased learning corpus. → Every episode is accounted; anomalies get investigated, labeled, kept.
7. Monetization defaults (author's 50bps Jupiter referral), ToS-violating Discord selfbot. → Drop.

**Bottom line:** Meridian validates the *deterministic core* and provides field-tested screening/exit numbers, but its learning layer is decorative. Our edge = measurement rigor + real statistical learning + backtest-gated evolution.

---

## 4. Domain primer: Meteora DLMM mechanics (verified against docs.meteora.ag, mid-2026)

Program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`. TS SDK: `@meteora-ag/dlmm` (v1.9.10, repo MeteoraAg/dlmm-sdk; Rust `commons` crate + community Python SDK in-repo). Data API: `https://dlmm.datapi.meteora.ag` (+ `pool-discovery-api.datapi.meteora.ag`).

### 4.1 Bin model
- Pool = (Token X, Token Y, bin step). Same pair can have many pools at different bin steps.
- Geometric price ladder: `price(n+1) = price(n) × (1 + s/10000)`, s = bin step in bps (1–400 typical).
- Within a bin: constant-sum `P·x + y = L` → **zero slippage within a bin**; price impact only on bin crossings.
- **Active bin** is the only bin holding both tokens. Bins left of it = 100% quote (Y); right = 100% base (X). Only bins the price trades through earn fees.
- Positions: PositionV2 supports up to **1,400 bins** (was 69); BinArray accounts hold 70 bins each.

### 4.2 Fees (exact, from docs)
- Total swap fee `f_s = f_b + f_v`, computed per bin crossed, pro-rata to that bin's LPs.
- Base: `f_b = B · s · 10 · 10^(base_fee_power_factor)`.
- Variable: `f_v(k) = A · (v_a(k) · s)²` where the **volatility accumulator** `v_a(k) = v_r + |i_r − (activeID + k)|` — volatility is measured in *bins crossed*, with time-decay: no decay if last trade < filter period `t_f`; decayed by factor R if `t_f ≤ t < t_d`; reset to 0 if `t ≥ t_d`. This is why volatile pools pay LPs surge fees.
- Protocol split: 10% standard pools / 20% launch pools; swap hosts get 20% of protocol fee as referral. Fees do **not** auto-compound — must be claimed.

### 4.3 Position economics (bot-critical numbers)
- Position rent ≈ **0.057–0.059 SOL, refundable** on close. Extension rent for >69 bins: refundable.
- **binArray creation ≈ 0.071–0.075 SOL each, NON-refundable**, paid by the first LP to touch those bins — wide ranges over virgin bins burn several tenths of a SOL. Budget check before opening.
- `initialize_bin_array` ≈ 250k CU. Meteora's own UI lands DLMM txs via **Jito only** — the bot needs priority fees and/or Jito tips, especially at launches.
- Range exits: price above range → 100% quote (fully sold on the way up); below range → 100% base (fully bought the dump). Position earns nothing while out of range.

### 4.4 Liquidity shapes
- **Spot** (uniform) — default, any condition. Sub-styles: concentrated 1–3 bins (stables), spread 20–30, wide ~50.
- **Curve** (bell around active bin) — stables/tight ranges, max capital efficiency, max IL risk, needs recentering.
- **Bid-Ask** (V-shape, capital at range ends) — volatile/choppy markets; **single-sided Bid-Ask = fee-earning DCA ladder** (the community's core weapon).
- SDK: `StrategyType.{Spot,Curve,BidAsk}`, `singleSidedX`; key calls: `DLMM.create`, `getActiveBin`, `getFeeInfo`/`getDynamicFee`, `initializePositionAndAddLiquidityByStrategy`, `addLiquidityByStrategyChunkable`, `removeLiquidity({shouldClaimAndClose})`, `claimAllSwapFee`, `swapQuote`/`swap`.

### 4.5 2025–2026 changes a bot must exploit
- **`rebalance_liquidity` instruction** — add/remove/shift/resize in ONE tx (no close/reopen churn). This makes recentering strategies far cheaper than when Meridian was designed. Also `initialize_position2` (idempotent), `close_position_if_empty`.
- **DLMM Limit Orders** (May 2026): single-token orders over up to 50 bins, filled natively, tokens leave the book on fill (no re-conversion when price crosses back), LOs earn 50% of the LO fee portion. → Native TP/exit-ladder primitive.
- **Quote-only fee collection** (`OnlyY` mode): fees accrue in SOL/quote on supporting pools — simplifies SOL-denominated accounting.
- **PermissionlessV2**: Token-2022, any quote token.
- **Anti-Sniper Suite** (Fee Scheduler on DAMM/DBC, dynamic fees on DLMM launches, Rate Limiter, Alpha Vault): launch pools can carry 20–50% effective fees early — model this or get shredded; conversely, LPs deliberately farm snipers through it.
- Breaking changes: v0.11.0 removed `amount_x_in/out` from bin state, renamed `reward_per_token_stored` → `function_bytes` — pin SDK versions, watch the changelog.
- DAMM v2 is a *separate* program (position NFTs, fee scheduler, ~0.022 SOL creation) — out of scope v1, candidate for fleet expansion later.

---

## 5. Strategy meta: what profitable LPs actually do (community, 2025–2026)

### 5.1 The two referenced X posts (recovered verbatim via unrollnow.com)
- **@MeteoraIDN 2071787054137319911 (2026-07-02) — the "dead pool" exit checklist.** Silent LP killer = staying parked in an unproductive pool. Four death signs: (1) 5-min volume collapses (e.g. 500k+ → <50k) and stays down >1 h; (2) TVL rising while volume falls (new LPs diluting fee share); (3) <100 transactions per 5 min; (4) whales/token-pushers exiting (narrative over). **Rule: 2 of 4 → rotate capital.** → Adopt directly as a deterministic exit rule (E6 in §6.2).
- **@bengsharksol 2072128486454825040 (2026-07-02)** — minor scanner-win post (his scanner flagged a token pre-pool; he bought spot). The account's signature content is the **Zen Bid-Ask strategy** (Nov 2025): rug-check first; pools with 5%+ base fee and dynamic fees; deposit SOL only; Bid-Ask; floor at −70…−75%; three outcomes (never enters range = no loss; dips & recovers = fees + discounted entry; chops = fees offset IL); exit at target or new ATH.

### 5.2 The dominant meta
**Single-sided SOL, Bid-Ask, wide (−50% to −90%), on trending high-fee memecoin pools; exit on first/second bounce; denominate in SOL; rotate fast when volume dies.** Named variants to encode as distinct configs in the fleet population: Zen Bid-Ask (above); One-Sided Flip (SOL bid → dump converts to tokens → withdraw, re-enter token-side ask → bounce converts back to SOL+profit); Retrace Bid-Ask (tight bid-ask under a pumping token — this is 0xyunss's own strategy, hence Meridian's shape); Mixed BidAsk (half spot/half bid-ask at RSI/volume peaks); Spot Wide single-sided SOL −80/−90% with size; AST/anti-sawtooth (tight + frequent rebalance for chop); 20-Bin (0.2% fee, ranging majors, mcap ≥$20M); DLMM Sell (exit a bag via ask-side position, earning fees instead of market-dumping).

### 5.3 Screening numbers in actual use (entry-side priors)
- **Fee/TVL is the core metric but naive 24h Fee/TVL is a mirage** (TVL is dynamic; wash volume exists). GeekLad's method: project fee/TVL from 5m/1h/6h/24h volume, take the **minimum** projection, require **up-trending** volume. → Implement this exact estimator.
- Filter sets seen in the wild: Tokleo (min mcap $10M, liq $500K, bin step ≥80, quote=SOL); MeteoraIDN bootcamp (Jupiter organic score ≥70, mcap ≥$250K, holders ≥500, lifetime fees ≥25–30 SOL); GMGN 5m vol >$50K + liq >$100K + mcap >$500K + rising volume only; Meridian's set (§3.1).
- Fee-tier matching: 5–10% pools for fresh/volatile tokens; ~2% "safe"; 0.2–0.5% majors. Bin-step ↔ volatility matching (bin step 100 ≈ −29/+40% per 69-bin position; 250 ≈ −57/+132%).
- Anti-rug: rugcheck.xyz, bubblemaps, bundled-wallet %, mint/freeze authority revoked, top-10 concentration, dev-wallet watch.

### 5.4 Documented failure modes (each must map to a mitigation in §9)
1. Rugs (single-sided SOL converts into a worthless token)
2. One-way dumps through the range, no bounce → 100% dead token
3. Sawtooth chop + over-rebalancing (grinds IL on every rebalance; Gauntlet: naive auto-rebalancing mostly *locks in* IL)
4. Parking in dead pools (fee share dilutes) — the MeteoraIDN post
5. Fee/TVL mirage & wash volume
6. Rent/gas bleed on small positions (0.057 SOL rent × churn; non-refundable binArrays)
7. Panic-closing at max IL instead of holding for bounce/fee offset
8. Compounding wins into ever-bigger meme positions until one rug erases the streak
9. Being on the wrong side of launch-fee windows (buying through 20–50% fees)
10. Strategy–pool mismatch (curve/narrow on a volatile pair; treating DLMM as passive farm)

### 5.5 Academic grounding (why this can work at all)
- **LVR** (Milionis et al., arXiv:2208.06046): adverse selection costs LPs ½σ²·(marginal liquidity) continuously; concentration scales fees AND LVR together. Fees-with-fast-blocks follow-up (arXiv:2305.14604): **faster blocks shrink arb losses — Solana DLMM is structurally better for LPs than mainnet Uniswap v3.** Empirics (arXiv:2404.05803): on Uniswap, fees often did NOT cover arb losses; ~half of v3 LPs underperform HODL (arXiv:2111.09192). → **Null hypothesis for every pool: "LPing here loses money net." The system must prove otherwise from data.**
- **Fan et al. (arXiv:2106.12033)**: optimal "reset-band" strategies formalize the width-vs-fees trade-off → our policy class.
- DRL for range management works in-sim (arXiv:2309.10129: 9–69% over baselines) but no robust live evidence → DRL is a v2+ upgrade, not the foundation.
- Where fee income CAN beat LVR: high-volume, high-dynamic-fee, fast-block pools — exactly the memecoin meta the community converged on empirically.

---

## 6. Target architecture

### 6.1 Inner loop — deterministic policy per instance

Config vector (the unit of learning, versioned, hashable):

```
θ = {
  // entry screening
  filters: { mcap_min/max, tvl_min/max, holders_min, organic_min, feeTvl_min(GeekLad-min-projection),
             binstep_range, lifetime_fees_min_sol, bot_pct_max, top10_pct_max, launchpad_lists, cooldowns },
  // position construction
  shape: Spot|Curve|BidAsk, side: single_Y|single_X|dual,
  bins_below, bins_above, width_vol_scaling, center_offset,
  size_fn: clamp(deployable × f, min_sol, max_sol), max_concurrent,
  // management
  recenter_trigger_k (active bin exits middle k bins), min_dwell_time, use_rebalance_ix: bool,
  claim_threshold_usd, compound_policy,
  // exits (all deterministic)
  stop_loss_pct, take_profit_pct, trailing: {arm_pct, drop_pct, confirm_ticks},
  oor_above_minutes, low_yield_rule, dead_pool_rule (2-of-4 MeteoraIDN),
  // regime gating
  regime_overrides: {calm: {...}, trending: {...}, crisis: halt}
}
```

Execution: TS/Node service per instance (or one service, N logical instances) on `@meteora-ag/dlmm`; 3s PnL poller with 2-tick exit confirmation (Meridian pattern); Jito tips/priority fees; idempotent tx submission; state in SQLite/Postgres, not JSON files.

**Guardian (separate module, veto on every tx):** per-position and per-instance exposure caps, global daily-loss halt, price sanity vs external oracle (Jupiter price API), gas/rent budget ceiling per episode, blacklist enforcement, "no new positions" global switch on portfolio drawdown. Code-only; no learning loop can modify it.

### 6.2 The measurement layer (this IS the "learn why we win/lose" feature)

Append-only event log, point-in-time correct:
- **Decision events:** ts, instance, θ-hash, action, and the exact feature snapshot seen (active bin, price, 1h/24h realized vol, GeekLad fee/TVL projection, volume trend, TVL, bin-liquidity distribution, tx/5min, holder metrics, regime label, safety score, gas, inventory). Plus action propensity if the policy ever randomizes (enables off-policy evaluation later).
- **Episodes (on close):** decomposed PnL in SOL =
  `fees_claimed − IL_vs_HODL − rebalance_realized_loss − swap_costs − tx_fees − nonrefundable_rent`
  + benchmarks on the same window: HODL-SOL and a fixed reference config; + **cause label** (rule-derived first: `rug | trended_out_below | trended_out_above | vol_collapse | chop_grind | dead_pool_rotation | tp | trailing_tp | sl`; LLM-annotated second).
- **Raw swap stream** per traded pool (Helius/Geyser or polling) → powers the replay backtester.

### 6.3 Middle loop — statistical learning

| Decision | Method | Notes |
|---|---|---|
| Regime label | 3-state HMM (calm/trending/crisis) on SOL returns + realized vol, rolling walk-forward refit | workhorse; gates θ tables; crisis → halt new entries |
| θ per (pool-type × regime) | TPE/Bayesian opt + evolutionary search over the replay backtester, **walk-forward validation only** | TPE overfits transient patterns — walk-forward is mandatory |
| Enter/skip a pool | Gradient-boosted classifier on own episode outcomes (profitable-net yes/no), calibrated probabilities | needs ≥100s of episodes; until then, hard filters only |
| Capital across instances | Risk-aware Thompson sampling (or discounted Exp3) on sliding-window risk-adjusted net SOL PnL | floors 2–5% min, caps ~25% max, drawdown embargo → demote to shadow, promote best shadow |
| Token/news risk | LLM classifier → bounded scalar feature | never a decision |
| Recenter timing (v2+) | RL that only modulates θ within bounds (Avellaneda-Stoikov+RL pattern) | only after live baseline exists |

**Replay backtester (the single most important asset):** given a pool's historical swap stream, the fees any hypothetical bin distribution would have earned are near-deterministically computable (add our liquidity's fee-share dilution + dynamic-fee state simulation from §4.2 formulas). Counterfactuals ("what if width were 2×?") become cheap and exact. Include: rent/binArray costs, priority fees, slippage on entry/exit swaps, and fee-share dilution from our own size.

### 6.4 Outer loop — LLM (Claude, not in the money path)

1. **Analyst:** weekly (and on drawdown events) reads episode table + decomposed PnL, writes hypothesis reports ("configs with bins_below < 40 bleed IL in trending regimes; propose trend-gated widening") → each hypothesis becomes candidate θs.
2. **Config evolution:** LLM as mutation operator over the θ population (AlphaEvolve pattern), evaluator = replay backtester. Stochasticity becomes diversity, not risk.
3. **Safety/narrative scorer:** classify token metadata/socials → bounded rug-risk feature.
4. **Code writer** for new strategy modules — reviewed, backtest-gated.

**Promotion pipeline (nothing skips a stage):**
candidate θ → replay backtest (walk-forward, costs) → shadow live ≥1–2 weeks → small live allocation → bandit takes over. Embargoed instances demote to shadow; best shadows fill freed live slots.

### 6.5 Fleet
10–20 live instances + 20–60 shadow. Reallocation daily or per-N-episodes. Judge nothing on <30–50 episodes. Global governor above the bandit: portfolio max-drawdown halt, per-pool and per-token exposure caps across ALL instances (else the whole fleet piles into the same hot pool — correlated rug risk).

---

## 7. Research workstreams (hand these to the research/build AI as phases)

### Phase 0 — Data foundation & replay backtester (2–3 weeks) ← everything depends on this
- Stand up pool discovery + market data ingestion (Meteora data API, Jupiter datapi, GMGN; Helius RPC/webhooks for swap streams).
- Implement the event log + episode schema (§6.2) in SQLite/Postgres.
- Build the replay backtester; **validate it against reality**: open a handful of tiny real positions, compare realized fees/IL to backtester predictions on the same window (target: within ~10–15%).
- Reproduce GeekLad's min-projection fee/TVL estimator; validate against his Dune dashboard.
- **Deliverable:** backtester + validation report. **Kill criterion:** if replay error is wildly off (>40%), stop and fix data before any strategy work.

### Phase 1 — Deterministic baseline (2 weeks, overlaps Phase 0)
- Implement ONE instance with Meridian-informed defaults: single-sided SOL Bid-Ask, bins_below 35–69 vol-scaled, hard filters from §3.1/§5.3, deterministic exits E1–E6 (incl. the 2-of-4 dead-pool rule), trailing TP, Guardian, SOL-denominated accounting.
- Run it in **shadow mode only** while Phase 0 completes; then tiny live capital (e.g. 2–5 SOL).
- **Deliverable:** live baseline + first ~30 episodes with full decomposed PnL. This baseline is the control group forever.

### Phase 2 — Attribution & measurement hardening (1–2 weeks)
- PnL decomposition on every close; cause-label rules; benchmark-vs-HODL on every episode.
- Dashboards: per-config, per-regime, per-cause aggregates; SOL-denominated equity curve.
- **Research question:** what fraction of losses is (a) rugs, (b) trend-through-range, (c) chop grind, (d) cost bleed, (e) dead-pool dilution? The answer sets Phase 3 priorities.

### Phase 3 — Statistical learning (3–4 weeks)
- HMM regime detector; crisis-halt rule.
- Walk-forward TPE/evolutionary optimization of θ over the backtester; produce per-(pool-type × regime) tables.
- Fleet-ify: 5–10 configs (encode §5.2 named strategies as distinct θs) in shadow; Thompson-sampling allocator in paper mode.
- **Deliverables:** regime detector eval (do per-regime tables beat one global θ out-of-sample?); allocator simulation on logged episodes.

### Phase 4 — LLM outer loop (2–3 weeks)
- Analyst report generator over the episode DB; hypothesis → candidate-θ pipeline; LLM mutation operator + backtest evaluator; safety-classifier feature.
- **Guardrail test:** demonstrate that a deliberately bad LLM proposal (e.g. "10× position size") cannot reach live capital.

### Phase 5 — Scale & self-sustainability (ongoing)
- 10–20 live instances, live bandit allocation, promotion/demotion automation, drawdown governor.
- Ops: alerting (Telegram), auto-restart, RPC failover, key management (consider a separate hot wallet per instance, cold sweep).
- Expansion candidates: DLMM Limit Orders as native TP ladders; quote-only fee pools; DAMM v2; majors pools (20-bin strategy) as a low-vol sleeve.

### Success metrics (evaluate at each phase gate)
- Primary: **net SOL PnL vs HODL-SOL benchmark** over rolling 30d, ≥30 episodes.
- Secondary: hit rate, avg win/avg loss, max drawdown, cost ratio (tx+rent+swap costs / gross fees — Alpha Arena's killer), % episodes ending in each cause label.
- Learning proof: shadow-promoted configs must outperform the Phase-1 frozen baseline out-of-sample; if after ~3 months nothing beats the frozen baseline, the learning layer is decoration — simplify and investigate.

---

## 8. Open research questions (for the research AI to answer with data)

1. **Bounce-probability estimation:** the whole single-sided-bid meta is a bet that dumps bounce. Can we estimate P(bounce ≥ x% | token features, dump speed, volume profile) from historical swap streams well enough to gate entries? This is likely the highest-alpha question.
2. **Optimal width under the fee-vs-LVR trade-off in bins:** does the Fan-et-al reset-band optimum, computed on our replay data with dynamic fees, agree with the community's −70% heuristic? Where does it diverge by regime?
3. **Rebalance vs rotate:** with `rebalance_liquidity` making recentering ~1 tx, when is recentering better than Meridian-style close-and-redeploy? (Gauntlet says naive rebalancing locks in IL — quantify on our pools.)
4. **Dead-pool rule calibration:** are MeteoraIDN's 2-of-4 thresholds optimal? Fit exit-timing on historical pool-death events.
5. **Wash-volume detection:** can we beat Jupiter organic score with swap-stream features (self-trades, bundler patterns, unique-taker counts)?
6. **Launch-window strategy:** is LPing into anti-sniper high-fee windows (farming snipers) net-positive at our size, and what filters make it safe?
7. **Fleet correlation:** how much does per-token/per-pool exposure capping across instances cost in returns vs save in correlated-rug drawdowns?
8. **Verify the unverified:** Meridian's PnL claims (pull the author's wallets on-chain if identifiable); current status of "dlmm.tools"/"met-ai" (probably stale names); exact current rent numbers from a live `quoteCreatePosition` call.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Rug/token collapse | Hard filters + safety classifier + per-token exposure cap + small sizes + stop-loss; accept as a *priced* cost, target: rug losses < X% of gross fees |
| One-way dump through range | Wide floors, bounce-gating (Q1 §8), crisis-regime halt, stop-loss on token value not just position PnL |
| Chop grind / over-rebalance | min_dwell_time, rebalance cost accounting in backtester, AST-style configs only where backtest supports |
| Cost bleed | Cost ratio as first-class metric; min position size; binArray-rent budget check pre-open; claim thresholds |
| Fake volume | GeekLad min-projection + organic score + own wash detector (Q5) |
| Software bug (cf. Meridian's silent stop-loss outage) | Guardian is a *separate* process; watchdog alerts if exits stop firing; chaos-test the kill paths |
| LLM contamination of decisions | Architecture (§6.4) + promotion pipeline + guardrail test (Phase 4) |
| Overfitting our own history | Walk-forward everywhere; frozen baseline control; ≥30-episode minimum; shadow gate |
| Key compromise | Per-instance hot wallets, minimal balances, cold sweep, no keys in LLM context ever |
| SDK/program breaking changes | Pin versions; watch MeteoraAg changelog (v0.11.0 precedent); integration tests on devnet |

---

## 10. Suggested stack

- **Execution & data:** TypeScript/Node (`@meteora-ag/dlmm` is first-class there), Helius RPC + webhooks, Jito bundles for landing.
- **Store:** Postgres (episodes, decisions, swap streams) — not flat JSON.
- **Research/learning:** Python (hmmlearn/pomegranate, Optuna for TPE, LightGBM/XGBoost, simple Thompson sampling — no heavy RL frameworks in v1). Backtester either TS (shares fee-math code with execution — preferred) or Python with a ported, unit-tested fee model.
- **LLM outer loop:** Claude (Opus/Sonnet) via API; prompts and outputs logged; all outputs treated as untrusted candidates.
- **Ops:** Docker per instance, Telegram alerts, Grafana on Postgres.

## 11. Instructions to the research AI receiving this document

1. Treat §4 formulas and §3 teardown as verified as of 2026-07-02; re-verify anything older than ~1 month against docs.meteora.ag and the MeteoraAg GitHub before building on it (they made breaking changes twice in 2026).
2. Execute phases in order; Phase 0's backtester-validation kill criterion is real — do not proceed on bad data.
3. Never relax the three hard rules: no LLM in the money path, nothing live without backtest+shadow, Guardian is immutable code.
4. Anything in §8 you answer, write up with data; anything you cannot verify, mark unverified — do not let it silently become an assumption.
5. Denominate every report in SOL, always against the HODL-SOL benchmark.

## 12. Key sources
- Meteora docs: docs.meteora.ag (DLMM concepts / fee calculation / strategies / developer guide / limit orders / collect-fee-mode / anti-sniper suite)
- SDK: github.com/MeteoraAg/dlmm-sdk · npm @meteora-ag/dlmm
- Meridian: github.com/yunus-0x/meridian · agentmeridian.xyz
- Community: unrollnow.com/status/2071787054137319911 (dead-pool checklist) · unrollnow.com/status/2072128486454825040 · bengsharksol "Zen Bid-Ask" (status 1986957749314634137) · thewise.trade/dlmm-guide · GeekLad (github.com/GeekLad/meteora-profit-analysis, dune.com/geeklad/meteora-dlmm-fee-to-tvl) · meteora-dlmm-recap.vercel.app · madbearsclub.com · solanaguides.com (AST-70, 20-bin) · HawkFi docs · SOL Decoder docs
- LLM-trading failure evidence: nof1.ai Alpha Arena · arXiv:2510.07920 (Profit Mirage) · arXiv:2505.07078 (FINSABER) · arXiv:2602.18481 (AlphaForgeBench) · arXiv:2512.02261 (TradeTrap) · arXiv:2510.11695 (LiveTradeBench)
- LP theory: arXiv:2208.06046 (LVR) · arXiv:2305.14604 (LVR w/ fees, fast blocks) · arXiv:2404.05803 · arXiv:2111.09192 (v3 LP profitability) · arXiv:2106.12033 (Fan et al., reset-band) · arXiv:2309.10129 (DRL for LP) · arXiv:2410.09983 (CLMM backtesting) · Gauntlet ALM analysis (gauntlet.xyz)
- Learning machinery: PLOS One AS+RL · arXiv:2409.06289 (QuantEvolve) · MDPI Mathematics 14(5):761 (TPE vs GA, walk-forward) · arXiv:2602.07472 (bandit allocational instability) · Lopez-Lira & Tang arXiv:2306.14222
