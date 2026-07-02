// Ingestion daemon: pool discovery, metrics + bin snapshots, swap capture
// (live tail + gap-fill + backfill). Run: pnpm ingestd
import { Connection } from "@solana/web3.js";
import { createDb, getIngestCursor, getOpenValidationPools, getWatchlistedPools, takeRetryableSigs } from "@agentic-dlmm/db";
import { JupiterClient } from "./clients/jupiter.js";
import { MeteoraDatapi } from "./clients/meteora.js";
import { getConfig } from "./config.js";
import { BinSnapshotter } from "./jobs/binSnapshots.js";
import { runDiscovery } from "./jobs/discovery.js";
import { MetricsSnapshotter } from "./jobs/metrics.js";
import { LiveTail } from "./capture/liveTail.js";
import { backfillPool, gapFillPool, type CaptureDeps } from "./capture/signatures.js";
import { TxProcessor } from "./capture/txProcessor.js";
import { log } from "./log.js";
import { PoolStateSource } from "./poolState.js";
import { RateLimiter } from "./rateLimiter.js";

const config = getConfig();
const db = createDb(config.databaseUrl);
const connection = new Connection(config.rpcUrl, { commitment: "confirmed", wsEndpoint: config.wsUrl });
// SDK account reads (snapshots, params) can use a separate endpoint: some free
// RPCs block methods the SDK needs while allowing heavy tx-fetch traffic.
const snapshotConnection =
  config.snapshotRpcUrl === config.rpcUrl
    ? connection
    : new Connection(config.snapshotRpcUrl, { commitment: "confirmed" });
const rpcLimiter = new RateLimiter(config.rpcRps);
const datapi = new MeteoraDatapi();
const jupiter = new JupiterClient(process.env.JUPITER_API_KEY || undefined);
const processor = new TxProcessor(db, connection, rpcLimiter);
const poolState = new PoolStateSource(snapshotConnection, rpcLimiter);
const tail = new LiveTail(connection, processor);
const metrics = new MetricsSnapshotter(db, datapi, jupiter);
const binSnapshots = new BinSnapshotter(db, poolState, config.snapshotBinsPerSide);
const captureDeps: CaptureDeps = { db, connection, limiter: rpcLimiter, processor };

const envPins = (process.env.WATCH_POOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function pinned(): Promise<string[]> {
  return [...new Set([...envPins, ...(await getOpenValidationPools(db))])];
}

// ---- backfill worker (one pool at a time, background) ----
const backfillQueue: string[] = [];
const backfillQueued = new Set<string>();
let backfillRunning = false;

function enqueueBackfill(pool: string): void {
  if (backfillQueued.has(pool)) return;
  backfillQueued.add(pool);
  backfillQueue.push(pool);
  void drainBackfills();
}

async function drainBackfills(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    while (backfillQueue.length > 0 && !shuttingDown) {
      const pool = backfillQueue.shift()!;
      backfillQueued.delete(pool);
      const sinceTs = new Date(Date.now() - config.backfillHours * 3600 * 1000);
      try {
        await backfillPool(captureDeps, pool, sinceTs);
      } catch (err) {
        log.error({ pool, err: (err as Error).message }, "backfill failed");
      }
    }
  } finally {
    backfillRunning = false;
  }
}

// ---- interval scheduler with overlap guard ----
let shuttingDown = false;
const timers: NodeJS.Timeout[] = [];

function every(name: string, ms: number, fn: () => Promise<void>): void {
  let running = false;
  const tick = async () => {
    if (running || shuttingDown) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error({ task: name, err: (err as Error).message }, "task failed");
    } finally {
      running = false;
    }
  };
  timers.push(setInterval(() => void tick(), ms));
  void tick();
}

async function discoveryRound(): Promise<void> {
  const watchlist = await runDiscovery({
    db,
    datapi,
    poolState,
    watchlistSize: config.watchlistSize,
    pinned,
  });
  await tail.syncPools(watchlist);
  for (const pool of watchlist) {
    const cursor = await getIngestCursor(db, pool);
    if (!cursor?.backfill_complete) enqueueBackfill(pool);
  }
}

async function gapFillRound(): Promise<void> {
  const pools = await getWatchlistedPools(db);
  for (const pool of pools) {
    try {
      const n = await gapFillPool(captureDeps, pool.address);
      if (n > 0) log.info({ pool: pool.address, txs: n }, "gap-fill caught up");
    } catch (err) {
      log.warn({ pool: pool.address, err: (err as Error).message }, "gap-fill failed");
    }
  }
}

async function retryRound(): Promise<void> {
  const retryable = await takeRetryableSigs(db, 200);
  if (retryable.length === 0) return;
  const byPool = new Map<string, string[]>();
  for (const { sig, pool } of retryable) {
    const key = pool ?? "unknown";
    (byPool.get(key) ?? byPool.set(key, []).get(key)!).push(sig);
  }
  for (const [pool, sigs] of byPool) {
    if (pool === "unknown") continue;
    await processor.processSignatures(sigs, pool);
  }
  log.info({ txs: retryable.length }, "retried failed tx fetches");
}

every("discovery", config.discoveryIntervalMs, discoveryRound);
every("metrics", config.metricsIntervalMs, () => metrics.run());
every("bin-snapshots", config.binSnapshotIntervalMs, () => binSnapshots.run());
every("gap-fill", config.gapFillIntervalMs, gapFillRound);
every("tx-retry", 5 * 60 * 1000, retryRound);

log.info(
  {
    rpcRps: config.rpcRps,
    watchlistSize: config.watchlistSize,
    backfillHours: config.backfillHours,
    pins: envPins,
  },
  "ingestd started",
);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  for (const t of timers) clearInterval(t);
  await tail.stop();
  await db.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
