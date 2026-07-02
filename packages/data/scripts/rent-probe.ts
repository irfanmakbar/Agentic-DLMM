/**
 * Live rent probe (answers RESEARCH_PLAN §8 Q8): what does opening a position
 * actually cost in rent, and how much of it is non-refundable?
 *
 * Uses SDK quoteCreatePosition on a live pool for several strategy widths and
 * getMinimumBalanceForRentExemption for the raw account sizes.
 *
 * Usage: pnpm tsx packages/data/scripts/rent-probe.ts [pool]
 */
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getConfig } from "../src/config.js";
import { dlmm } from "../src/sdk.js";

const POOL = process.argv[2] ?? "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"; // SOL-USDC bs4

async function main() {
  const cfg = getConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const instance = await dlmm.create(conn, new PublicKey(POOL), { cluster: "mainnet-beta" });
  const activeBin = instance.lbPair.activeId;

  // raw account-size rents for reference
  const binArraySize = 8 + 24 + 70 * 144; // discriminator + header + 70 bins (v1 layout ~10136)
  for (const [label, size] of [
    ["binArray (10136B nominal)", 10136],
    [`binArray (computed ${binArraySize}B)`, binArraySize],
    ["position v2 (8120B)", 8120],
  ] as const) {
    const lamports = await conn.getMinimumBalanceForRentExemption(size);
    console.log(`rent-exempt ${label}: ${(lamports / 1e9).toFixed(6)} SOL`);
  }

  for (const width of [10, 34, 69, 140]) {
    const quote = await instance.quoteCreatePosition({
      strategy: {
        minBinId: activeBin - Math.floor(width / 2),
        maxBinId: activeBin + Math.ceil(width / 2),
        strategyType: 0, // spot
      },
    } as never);
    console.log(
      `width=${width} bins: positions=${quote.positionCount} positionCost=${quote.positionCost} SOL ` +
        `binArrays=${quote.binArraysCount} binArrayCost=${quote.binArrayCost} SOL txs=${quote.transactionCount}`,
    );
  }
  console.log(
    "\nnote: positionCost is refundable on close; binArrayCost is NOT refundable " +
      "(bin arrays are permanent, shared pool infrastructure — cost applies only for virgin arrays).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
