# Why LLM-inner-loop trading fails + what works (evidence, 2026-07-02)

**Why the Gemini bot lost (architectural, evidence-backed):** Alpha Arena (nof1.ai, real money): 4/6 frontier LLMs lost, Gemini 2.5 Pro −56.7%; PnL dominated by over-trading costs. "Profit Mirage" (arXiv:2510.07920): LLM backtest alpha = training-data memorization (−50…−72% post-cutoff). FINSABER (arXiv:2505.07078): statistically zero alpha, poor risk control. AlphaForgeBench (arXiv:2602.18481): statelessness, classification-not-optimization, non-determinism. Adding episodic memory to LLM traders makes them WORSE (retrieval bias → overconfidence). Eval lesson: n=1 runs are meaningless — require ≥30–50 episodes per config.

**What works (middle loop):** 3-state HMM regime detection + per-regime θ tables, walk-forward refit; TPE/Bayesian + evolutionary search over a replay backtester (TPE overfits → walk-forward mandatory, MDPI Math 14(5):761); gradient-boosted enter/skip classifier on own episodes; risk-aware Thompson sampling / discounted Exp3 for capital allocation (floors+caps+sliding window, arXiv:2602.07472 instability caveat); AS+RL pattern (RL modulates an analytic policy's params) only as v2+.

**LP-specific:** Fan et al. reset-band policy class (arXiv:2106.12033) → θ = {width, shape, center offset, recenter trigger, dwell, exits}; replay backtesting of CLMMs is near-deterministic from swap streams (arXiv:2410.09983) — counterfactuals are cheap; DRL works in-sim only (arXiv:2309.10129), not foundation.

**Safe LLM roles (outer loop only, all gated by backtest→shadow→small-live):** post-hoc analyst/hypothesis generator; config mutation operator in evolutionary loop (QuantEvolve arXiv:2409.06289, AlgoEvolve); token/news risk classifier as bounded feature (Lopez-Lira & Tang); code writer for new modules. Anti-patterns: LLM sizing, LLM per-tick reads, similarity-retrieved trade memory in prompt, LLM as its own risk check.

**Guardian pattern:** separate rule-based validator w/ final veto + kill-switch, code-only, unmodifiable by learning loops (TradeTrap arXiv:2512.02261 shows unguarded loops → runaway exposure).

See RESEARCH_PLAN.md §2/§6. Related: `mem:project-brief`.