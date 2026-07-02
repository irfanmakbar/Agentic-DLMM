# DLMM community strategy meta (2025–2026), researched 2026-07-02

**The two X posts Irfan referenced (recovered verbatim via unrollnow.com):**
- @MeteoraIDN 2071787054137319911 — "dead pool" exit checklist. 4 signs: 5m volume collapse (500k+→<50k, >1h), TVL up while volume down (fee-share dilution), <100 tx/5min, whales exiting. **Rule: 2-of-4 → rotate.** Adopted as deterministic exit rule E6.
- @bengsharksol 2072128486454825040 — minor scanner win-post. His signature = **Zen Bid-Ask**: rug-check; 5%+ base fee + dynamic fees; SOL-only Bid-Ask, floor −70/−75%; exit at target or new ATH.

**Dominant meta:** single-sided SOL Bid-Ask, wide (−50…−90%), trending high-fee meme pools, exit on first/second bounce, denominate in SOL, rotate when volume dies. Named variants to encode as fleet configs: One-Sided Flip, Retrace Bid-Ask (0xyunss), Mixed BidAsk, Spot Wide, AST/anti-sawtooth, 20-Bin (majors), DLMM Sell.

**Screening numbers in use:** GeekLad estimator = min of fee/TVL projections from 5m/1h/6h/24h volume + require rising volume (naive 24h fee/TVL is a mirage). Filters: organic score ≥60–70, mcap floors $250k–$10M, holders ≥500, lifetime fees ≥25–30 SOL, bin step ≥80 for memes, quote=SOL. Fee tiers: 5–10% fresh/volatile, ~2% safe, 0.2–0.5% majors.

**10 failure modes:** rugs; one-way dump through range; sawtooth/over-rebalance (Gauntlet: naive rebalancing locks in IL); dead-pool parking; fee/TVL mirage + wash volume; rent/gas bleed; panic-close at max IL; compounding into one wipeout; buying through launch-fee windows; strategy–pool mismatch.

**Theory:** LVR (arXiv:2208.06046) = null hypothesis "every pool loses net" — must be disproven per pool; fast Solana blocks structurally reduce arb losses (arXiv:2305.14604); ~half of Uniswap v3 LPs underperform HODL. Fee income can beat LVR exactly where the meta is: high-volume high-dynamic-fee pools.

See RESEARCH_PLAN.md §5. Related: `mem:project-brief`, `mem:dlmm-mechanics`.