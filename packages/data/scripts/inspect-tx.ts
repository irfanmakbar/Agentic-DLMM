// Debug helper: fetch given signatures and show what the decoder sees.
import { Connection } from "@solana/web3.js";
import { decodeDlmmTransaction, extractRawEvents } from "../src/events/decoder.js";
import { getConfig } from "../src/config.js";
import { DLMM_PROGRAM_ID } from "../src/sdk.js";

const sigs = process.argv.slice(2);
const cfg = getConfig();
const conn = new Connection(cfg.rpcUrl, "confirmed");

for (const sig of sigs) {
  const tx = await conn.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    console.log(sig.slice(0, 12), "NOT FOUND");
    continue;
  }
  const raw = extractRawEvents(tx);
  const dec = decodeDlmmTransaction(tx, sig, "unknown");
  const topPrograms = tx.transaction.message.instructions.map((ix) => ix.programId.toBase58());
  const innerPrograms = (tx.meta?.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((ix) => ix.programId.toBase58()),
  );
  const mentionsDlmm = [...topPrograms, ...innerPrograms].includes(DLMM_PROGRAM_ID);
  console.log(
    sig.slice(0, 12),
    "err=", tx.meta?.err ? JSON.stringify(tx.meta.err).slice(0, 40) : null,
    "| dlmmInvoked=", mentionsDlmm,
    "| rawEvents=", raw.map((r) => r.name).join(",") || "(none)",
    "| swaps=", dec.swaps.length, "liq=", dec.liquidityEvents.length,
  );
  console.log("  top:", [...new Set(topPrograms)].join(", "));
  console.log("  inner:", [...new Set(innerPrograms)].slice(0, 8).join(", ") || "(none)");
  await new Promise((r) => setTimeout(r, 1200));
}
