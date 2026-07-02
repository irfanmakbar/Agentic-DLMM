// Decode recent DLMM transactions from a busy pool and print events.
// Usage: pnpm tsx packages/data/scripts/smoke-decoder.ts [rpcUrl]
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeDlmmTransaction, extractRawEvents } from "../src/events/decoder.js";

const rpcUrl = process.argv[2] ?? "https://api.mainnet-beta.solana.com";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"; // SOL-USDC busiest

const conn = new Connection(rpcUrl, "confirmed");
const sigs = await conn.getSignaturesForAddress(new PublicKey(POOL), { limit: 8 });
console.log(`fetched ${sigs.length} signatures`);

let decodedAny = false;
for (const s of sigs.filter((s) => s.err === null).slice(0, 5)) {
  const tx = await conn.getParsedTransaction(s.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) continue;
  const raw = extractRawEvents(tx);
  const { swaps, liquidityEvents } = decodeDlmmTransaction(tx, s.signature, POOL);
  console.log(
    `${s.signature.slice(0, 16)}… events=[${raw.map((e) => e.name).join(",")}] swaps=${swaps.length} liq=${liquidityEvents.length}`,
  );
  if (swaps[0]) {
    const sw = swaps[0];
    console.log("  swap sample:", {
      pool: sw.pool.slice(0, 8),
      swapForY: sw.swapForY,
      bins: `${sw.startBin}->${sw.endBin}`,
      amountIn: sw.amountIn.toString(),
      amountOut: sw.amountOut.toString(),
      feeBps: sw.feeBps,
      fee: sw.fee?.toString(),
      protocolFee: sw.protocolFee?.toString(),
    });
    decodedAny = true;
  }
  await new Promise((r) => setTimeout(r, 800));
}
if (!decodedAny) {
  console.error("no swap decoded — inspect raw event names/fields above");
  process.exit(1);
}
