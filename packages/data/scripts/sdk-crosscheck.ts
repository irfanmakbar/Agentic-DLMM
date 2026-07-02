/**
 * Live SDK cross-check (tier 1 validation, network required):
 * for a mainnet pool, compare
 *  1. our totalFeeRate vs SDK getDynamicFee() from the live vParameters
 *  2. our walkSwapExactIn vs SDK swapQuote over real bin arrays
 *
 * Usage: pnpm tsx packages/data/scripts/sdk-crosscheck.ts [pool] [amountInLamports]
 * Default pool: SOL-USDC bin step 4.
 */
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicFeeState,
  totalFeeRate,
  walkSwapExactIn,
  type BinState,
  type StaticFeeParams,
} from "@agentic-dlmm/core";
import { getConfig } from "../src/config.js";
import { dlmm } from "../src/sdk.js";

const POOL = process.argv[2] ?? "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"; // SOL-USDC bs4
const AMOUNT_IN = new BN(process.argv[3] ?? "1000000000"); // 1 SOL

async function main() {
  const cfg = getConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const instance = await dlmm.create(conn, new PublicKey(POOL), { cluster: "mainnet-beta" });
  const lb = instance.lbPair;
  const s = lb.parameters;
  const v = lb.vParameters;

  const params: StaticFeeParams = {
    baseFactor: s.baseFactor,
    baseFeePowerFactor: Number(s.baseFeePowerFactor ?? 0),
    variableFeeControl: Number(s.variableFeeControl),
    filterPeriod: s.filterPeriod,
    decayPeriod: s.decayPeriod,
    reductionFactor: s.reductionFactor,
    maxVolatilityAccumulator: Number(s.maxVolatilityAccumulator),
    protocolShare: s.protocolShare,
  };

  // 1. fee rate now (static v_a, no decay applied — SDK getDynamicFee does the same)
  const ourRate = totalFeeRate(lb.binStep, params, Number(v.volatilityAccumulator));
  const sdkPct = instance.getDynamicFee(); // percent
  const ourPct = Number(ourRate) / 1e9 * 100;
  console.log(`pool ${POOL} binStep=${lb.binStep} activeBin=${lb.activeId}`);
  console.log(`fee rate:   ours=${ourPct.toFixed(6)}%  sdk=${sdkPct.toString()}%`);

  // 2. swap quote: X -> Y (swapForY), fee on input unless collectFeeMode says otherwise
  const binArrays = await instance.getBinArrayForSwap(true, 4);
  const quote = instance.swapQuote(AMOUNT_IN, true, new BN(10_000), binArrays, true);

  // rebuild bins map from the same bin arrays
  const bins = new Map<number, BinState>();
  for (const account of binArrays) {
    const lowerBinId = account.account.index.mul(new BN(70)).toNumber();
    account.account.bins.forEach((bin, idx) => {
      const binId = lowerBinId + idx;
      const lo = BigInt(bin.openOrderAmount?.toString() ?? "0") + BigInt(bin.processedOrderRemainingAmount?.toString() ?? "0");
      bins.set(binId, {
        binId,
        x: BigInt(bin.amountX.toString()),
        y: BigInt(bin.amountY.toString()),
        supply: BigInt(bin.liquiditySupply.toString()),
        loAmount: lo,
        loAskSide: Boolean(bin.limitOrderAskSide),
      });
    });
  }

  const feeState = new DynamicFeeState(lb.binStep, params, {
    volatilityAccumulator: Number(v.volatilityAccumulator),
    volatilityReference: Number(v.volatilityReference),
    indexReference: v.indexReference,
    lastUpdateTimestamp: Number(v.lastUpdateTimestamp.toString()),
  });
  // SDK swapQuote decays references with wall-clock now; mirror it exactly
  const ours = walkSwapExactIn({
    bins,
    binStep: lb.binStep,
    startBin: lb.activeId,
    swapForY: true,
    amountIn: BigInt(AMOUNT_IN.toString()),
    feeState,
    feeOnInput: true,
    supportsLimitOrder: dlmm.isSupportLimitOrder(lb),
    timestamp: Date.now() / 1e3,
  });

  const sdkOut = BigInt(quote.outAmount.toString());
  // SDK quote.fee = user-side fee (trading fee minus protocol cut)
  const sdkFee = BigInt(quote.fee.toString());
  const oursUserFee = ours.totalTradingFee - ours.totalProtocolFee;
  const outDiff = sdkOut === 0n ? 0 : Number(ours.totalAmountOut - sdkOut) / Number(sdkOut);
  const feeDiff = sdkFee === 0n ? 0 : Number(oursUserFee - sdkFee) / Number(sdkFee);
  console.log(`amountOut:  ours=${ours.totalAmountOut}  sdk=${sdkOut}  reldiff=${(outDiff * 100).toFixed(4)}%`);
  console.log(`userFee:    ours=${oursUserFee}  sdk=${sdkFee}  reldiff=${(feeDiff * 100).toFixed(4)}%`);
  console.log(`bins crossed: ours=${ours.fills.length} endBin=${ours.endBin} sdkEndPrice=${quote.endPrice.toString()}`);

  const ok = Math.abs(outDiff) < 0.001 && Math.abs(feeDiff) < 0.001;
  console.log(ok ? "PASS (within 0.1%)" : "FAIL (relative diff exceeds 0.1%)");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
