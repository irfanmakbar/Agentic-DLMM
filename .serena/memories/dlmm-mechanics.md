# Meteora DLMM mechanics — verified vs docs.meteora.ag (2026-07-02)

Program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`. SDK `@meteora-ag/dlmm` v1.9.10 (MeteoraAg/dlmm-sdk). Data API `dlmm.datapi.meteora.ag`, discovery `pool-discovery-api.datapi.meteora.ag`.

- Pool = (X, Y, bin_step). Price ladder `price(n+1)=price(n)×(1+s/10000)`. Constant-sum within bin → zero slippage inside a bin. Active bin = only bin with both tokens; left bins 100% quote, right bins 100% base; only traded-through bins earn fees.
- Fees per bin crossed: `f_s = f_b + f_v`; base `f_b = B·s·10·10^power`; variable `f_v(k)=A·(v_a(k)·s)²`, volatility accumulator `v_a(k)=v_r+|i_r−(activeID+k)|` measured in bins crossed, time-decayed (filter period t_f, decay period t_d, factor R). Protocol split 10% (20% launch pools); host referral = 20% of protocol fee. Fees do NOT auto-compound.
- Costs: position rent ~0.057–0.059 SOL refundable; **binArray ~0.071–0.075 SOL NON-refundable** (first LP to touch bins); init_bin_array ~250k CU; Meteora UI lands DLMM txs via Jito only → bot needs Jito tips/priority fees.
- Shapes: Spot (uniform), Curve (bell, stables, high IL risk), Bid-Ask (V, single-sided = fee-earning DCA ladder — the community weapon). PositionV2 up to 1,400 bins.
- 2026 upgrades a bot must exploit: **`rebalance_liquidity` ix** (recentering in one tx, no close/reopen), DLMM Limit Orders (May 2026, up to 50 bins, no re-conversion on cross-back, native TP ladders), quote-only fee mode (`OnlyY` — fees in SOL), PermissionlessV2 (any quote, Token-2022), anti-sniper suite (launch fees can be 20–50% early). Breaking: v0.11.0 removed amount_x_in/out from bin state — pin SDK versions.
- Bin-step ↔ range: step 100 ≈ −29/+40% per 69-bin position; step 250 ≈ −57/+132%.

Full detail in RESEARCH_PLAN.md §4. Related: `mem:project-brief`.