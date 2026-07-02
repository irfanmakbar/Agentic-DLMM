// Quick probe: how many getParsedTransaction calls per minute does an RPC allow?
import { Connection, PublicKey } from "@solana/web3.js";

const rpc = process.argv[2] ?? "https://api.mainnet-beta.solana.com";
const pool = process.argv[3] ?? "3YnMGsdLPe2ffBJ7xwUsmukqhHi1sdRURkmPc8jRL7Xr";

const conn = new Connection(rpc, "confirmed");
const sigs = (await conn.getSignaturesForAddress(new PublicKey(pool), { limit: 15 })).map(
  (s) => s.signature,
);
console.log("sigs:", sigs.length);
const t0 = Date.now();
let ok = 0;
let fail = 0;
for (const sig of sigs) {
  try {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (tx) ok++;
    else fail++;
  } catch {
    fail++;
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log("fetched ok=", ok, "fail=", fail, "elapsed_ms=", Date.now() - t0);
