# Meridian (yunus-0x/meridian) teardown — key findings (2026-07-02)

Real project by @0xyunss (Indonesian, MeteoraIDN/LP Army), ~15k LOC plain JS ESM, 633 stars/457 forks, created 2026-03, built with Claude Code. PnL claims ($20+/day, 80–90% hit rate) unverified. Bug history: Jun-12 bug silently disabled stop-loss/trailing exits ~2 weeks; "Degen Score" poller dead-calibrated for 3 months.

**Keep (as starting priors):**
- Hard deterministic screening: mcap $150k–$10M, holders ≥500, TVL $10k–$150k, fee/active-TVL ≥0.05, organic ≥60, bin step 80–125, ≥30 SOL lifetime fees (GMGN), bot holders ≤30%, top-10 ≤60%, blacklists, cooldowns.
- Deterministic exit engine (they REMOVED the LLM from exits in Jun 2026): SL; TP ≥5%; pumped >10 bins above range; OOR-above ≥30 min; low fee-yield after 60 min; trailing TP arm +3%, close −1.5% from 2-tick-confirmed peak.
- 3s on-chain PnL poller, 2-tick confirmation; mandatory base→SOL swap on close; gas reserve; max 3 concurrent.
- Strategy: single-sided SOL Bid-Ask below active bin, vol-scaled 35–69 bins_below.

**Fix (our differentiation):**
1. No backtesting — all live-money trial/error. 2. n=1 "learning": templated text lessons w/ invented confidence injected into prompts; "Darwinian weights" affect only prose. 3. One-directional only; −50% code stop-loss (README says −15%); no rebalancing, just close/redeploy churn. 4. HiveMind = prompt-poisoning vector (strangers' lessons injected, no true off switch). 5. Flat-JSON state re-read every 3s tick, races, no DB. 6. Skips "suspicious" PnL records → survivorship-biased corpus. 7. Author monetization (50bps Jupiter referral default), Discord selfbot.

Verdict: validates the deterministic core + field-tested numbers; learning layer is decorative. Our edge = measurement rigor + real statistics + backtest-gated evolution. See `mem:project-brief`.