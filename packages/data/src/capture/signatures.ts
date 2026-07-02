import { PublicKey, type ConfirmedSignatureInfo, type Connection } from "@solana/web3.js";
import { type Db, getIngestCursor, updateIngestCursor } from "@agentic-dlmm/db";
import { log } from "../log.js";
import type { RateLimiter } from "../rateLimiter.js";
import type { TxProcessor } from "./txProcessor.js";

export interface CaptureDeps {
  db: Db;
  connection: Connection;
  limiter: RateLimiter;
  processor: TxProcessor;
}

async function getSignaturesPage(
  deps: CaptureDeps,
  pool: string,
  opts: { before?: string; until?: string; limit?: number },
): Promise<ConfirmedSignatureInfo[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    await deps.limiter.acquire();
    try {
      return await deps.connection.getSignaturesForAddress(new PublicKey(pool), {
        before: opts.before,
        until: opts.until,
        limit: opts.limit ?? 1000,
      });
    } catch (err) {
      lastErr = err;
      log.warn({ pool, attempt, err: (err as Error).message }, "getSignaturesForAddress failed");
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

const ok = (s: ConfirmedSignatureInfo) => s.err === null;

/**
 * Backfill history for a pool until `sinceTs` (or until already-covered range).
 * Processes page-by-page; safe to interrupt (processed_txs dedupes).
 */
export async function backfillPool(deps: CaptureDeps, pool: string, sinceTs: Date): Promise<void> {
  const cursor = await getIngestCursor(deps.db, pool);
  if (cursor?.backfill_complete) return;
  let before = cursor?.oldest_sig ?? undefined;
  const sinceUnix = Math.floor(sinceTs.getTime() / 1000);

  for (;;) {
    const page = await getSignaturesPage(deps, pool, { before });
    if (page.length === 0) {
      await updateIngestCursor(deps.db, pool, { backfillComplete: true });
      log.info({ pool }, "backfill reached pool origin");
      return;
    }
    const first = page[0]!;
    const last = page[page.length - 1]!;
    if (!cursor?.newest_sig && !before) {
      // First page ever seen for this pool: its head is the live frontier.
      await updateIngestCursor(deps.db, pool, { newestSig: first.signature, newestSlot: first.slot });
    }
    const inRange = page.filter((s) => ok(s) && (s.blockTime ?? 0) >= sinceUnix);
    await deps.processor.processSignatures(inRange.map((s) => s.signature), pool);
    await updateIngestCursor(deps.db, pool, { oldestSig: last.signature, oldestSlot: last.slot });
    if ((last.blockTime ?? 0) < sinceUnix) {
      await updateIngestCursor(deps.db, pool, { backfillComplete: true });
      log.info({ pool, sinceTs }, "backfill complete");
      return;
    }
    before = last.signature;
  }
}

/**
 * Catch up from the newest processed signature to now. Serves as the gap-fill
 * safety net behind the live tail and as the initial hookup for new pools.
 */
export async function gapFillPool(deps: CaptureDeps, pool: string): Promise<number> {
  const cursor = await getIngestCursor(deps.db, pool);
  const until = cursor?.newest_sig ?? undefined;

  if (!until) {
    // Fresh pool: seed the frontier from the newest page only; history is
    // backfill's job.
    const page = await getSignaturesPage(deps, pool, { limit: 100 });
    if (page.length === 0) return 0;
    const newest = page[0]!;
    const oldest = page[page.length - 1]!;
    const stats = await deps.processor.processSignatures(
      page.filter(ok).map((s) => s.signature).reverse(),
      pool,
    );
    await updateIngestCursor(deps.db, pool, {
      newestSig: newest.signature,
      newestSlot: newest.slot,
      oldestSig: cursor?.oldest_sig ?? oldest.signature,
      oldestSlot: cursor?.oldest_sig ? undefined : oldest.slot,
    });
    return stats.fetched;
  }

  // Collect pages newest -> older until we hit `until`; then process oldest-first.
  const pages: ConfirmedSignatureInfo[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = await getSignaturesPage(deps, pool, { before, until });
    if (page.length === 0) break;
    pages.push(page);
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
    if (pages.length >= 20) {
      log.warn({ pool }, "gap-fill truncated at 20 pages");
      break;
    }
  }
  if (pages.length === 0) return 0;
  const newest = pages[0]![0]!;
  let processed = 0;
  for (const page of pages.reverse()) {
    const sigs = page.filter(ok).map((s) => s.signature).reverse();
    const stats = await deps.processor.processSignatures(sigs, pool);
    processed += stats.fetched;
  }
  await updateIngestCursor(deps.db, pool, { newestSig: newest.signature, newestSlot: newest.slot });
  return processed;
}
