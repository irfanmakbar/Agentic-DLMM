import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  type Db,
  filterUnprocessedSigs,
  insertLiquidityEvents,
  insertSwaps,
  markTxProcessed,
} from "@agentic-dlmm/db";
import { decodeDlmmTransaction } from "../events/decoder.js";
import { log } from "../log.js";
import type { RateLimiter } from "../rateLimiter.js";

export interface ProcessStats {
  fetched: number;
  swaps: number;
  liquidityEvents: number;
}

/** Fetches transactions (rate-limited) and persists decoded DLMM events. */
export class TxProcessor {
  constructor(
    private readonly db: Db,
    private readonly connection: Connection,
    private readonly limiter: RateLimiter,
  ) {}

  private async fetchParsed(sig: string): Promise<ParsedTransactionWithMeta | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.limiter.acquire();
      try {
        return await this.connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      } catch (err) {
        log.warn({ sig, attempt, err: (err as Error).message }, "getParsedTransaction failed");
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    return null;
  }

  /**
   * Process signatures for a pool (skips already-processed txs). Order does not
   * matter for correctness; rows carry slot ordering.
   */
  async processSignatures(sigs: string[], contextPool: string): Promise<ProcessStats> {
    const stats: ProcessStats = { fetched: 0, swaps: 0, liquidityEvents: 0 };
    const pending = await filterUnprocessedSigs(this.db, sigs);
    for (const sig of pending) {
      const tx = await this.fetchParsed(sig);
      if (!tx) {
        // Fetch failed or not visible yet: record with slot null; the ingestd
        // retry loop re-releases these for another attempt.
        await markTxProcessed(this.db, sig, null, contextPool);
        continue;
      }
      stats.fetched++;
      const { swaps, liquidityEvents } = decodeDlmmTransaction(tx, sig, contextPool);
      stats.swaps += await insertSwaps(this.db, swaps);
      stats.liquidityEvents += await insertLiquidityEvents(this.db, liquidityEvents);
      await markTxProcessed(this.db, sig, tx.slot, contextPool);
    }
    return stats;
  }
}
