// End-to-end capture smoke test: gap-fill recent txs of one pool into Postgres.
// Usage: pnpm tsx packages/data/scripts/smoke-capture.ts [pool]
import { Connection } from "@solana/web3.js";
import { createDb } from "@agentic-dlmm/db";
import { loadEnv } from "../src/config.js";
import { RateLimiter } from "../src/rateLimiter.js";
import { TxProcessor } from "../src/capture/txProcessor.js";
import { gapFillPool } from "../src/capture/signatures.js";

loadEnv();
const pool = process.argv[2] ?? "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const heliusKey = process.env.HELIUS_API_KEY;
const rpcUrl =
  process.env.RPC_URL ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.mainnet-beta.solana.com");

const db = createDb();
const connection = new Connection(rpcUrl, "confirmed");
const limiter = new RateLimiter(Number(process.env.RPC_RPS ?? 5));
const processor = new TxProcessor(db, connection, limiter);

// Seed cursor so gap-fill only takes the most recent page chunk.
const processed = await gapFillPool({ db, connection, limiter, processor }, pool);
console.log("processed txs:", processed);

const counts = await db.query(
  `select (select count(*) from swaps where pool = $1) swaps,
          (select count(*) from liquidity_events where pool = $1) liq,
          (select count(*) from processed_txs) txs`,
  [pool],
);
console.log(counts.rows[0]);
await db.end();
