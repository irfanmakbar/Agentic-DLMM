import { PublicKey, type Connection } from "@solana/web3.js";
import { log } from "../log.js";
import { DLMM_PROGRAM_ID } from "../sdk.js";
import type { TxProcessor } from "./txProcessor.js";

/**
 * Live capture trigger: logsSubscribe(mentions: pool) per watchlisted pool.
 * Signatures are queued and drained sequentially through the rate-limited
 * TxProcessor; the periodic gap-fill covers anything missed (ws drops, queue
 * overflow, restarts).
 *
 * Bot no-op transactions frequently mention hot pools without invoking the
 * program (aborted MEV attempts); the notification's logs let us skip them
 * before spending a getParsedTransaction call.
 */
export class LiveTail {
  private readonly subs = new Map<string, number>();
  private readonly queue: Array<{ sig: string; pool: string }> = [];
  private readonly queued = new Set<string>();
  private draining = false;
  private stopped = false;

  constructor(
    private readonly connection: Connection,
    private readonly processor: TxProcessor,
    private readonly maxQueue = 5000,
  ) {}

  async syncPools(pools: string[]): Promise<void> {
    const want = new Set(pools);
    for (const [pool, subId] of this.subs) {
      if (!want.has(pool)) {
        this.subs.delete(pool);
        await this.connection.removeOnLogsListener(subId).catch(() => {});
        log.info({ pool }, "live tail unsubscribed");
      }
    }
    for (const pool of want) {
      if (this.subs.has(pool)) continue;
      const subId = this.connection.onLogs(
        new PublicKey(pool),
        (logInfo) => {
          if (logInfo.err) return;
          if (!logInfo.logs.some((l) => l.includes(DLMM_PROGRAM_ID))) return;
          this.enqueue(logInfo.signature, pool);
        },
        "confirmed",
      );
      this.subs.set(pool, subId);
      log.info({ pool }, "live tail subscribed");
    }
  }

  private enqueue(sig: string, pool: string): void {
    if (this.queued.has(sig)) return;
    if (this.queue.length >= this.maxQueue) {
      // Drop oldest; gap-fill will recover it.
      const dropped = this.queue.shift();
      if (dropped) this.queued.delete(dropped.sig);
    }
    this.queue.push({ sig, pool });
    this.queued.add(sig);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const batch = this.queue.splice(0, 25);
        const byPool = new Map<string, string[]>();
        for (const { sig, pool } of batch) {
          this.queued.delete(sig);
          (byPool.get(pool) ?? byPool.set(pool, []).get(pool)!).push(sig);
        }
        for (const [pool, sigs] of byPool) {
          try {
            await this.processor.processSignatures(sigs, pool);
          } catch (err) {
            log.error({ pool, err: (err as Error).message }, "live tail batch failed");
          }
        }
        if (this.queue.length > 500) {
          log.warn({ depth: this.queue.length }, "live tail queue is deep; raise RPC_RPS or trim watchlist");
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [pool, subId] of this.subs) {
      this.subs.delete(pool);
      await this.connection.removeOnLogsListener(subId).catch(() => {});
    }
  }
}
