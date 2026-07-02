import { existsSync } from "node:fs";

let loaded = false;

/** Load .env from cwd once (repo root when run via pnpm scripts). */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(".env")) process.loadEnvFile(".env");
}

function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v ? Number(v) : dflt;
}

export interface DataConfig {
  databaseUrl: string;
  rpcUrl: string;
  wsUrl: string;
  /** RPC for SDK account reads (snapshots); defaults to rpcUrl */
  snapshotRpcUrl: string;
  jupiterApiKey: string | undefined;
  rpcRps: number;
  binSnapshotIntervalMs: number;
  metricsIntervalMs: number;
  discoveryIntervalMs: number;
  gapFillIntervalMs: number;
  watchlistSize: number;
  /** how far back the swap backfill reaches on first watchlisting */
  backfillHours: number;
  /** bins captured each side of the active bin in snapshots */
  snapshotBinsPerSide: number;
}

export function getConfig(): DataConfig {
  loadEnv();
  const heliusKey = process.env.HELIUS_API_KEY;
  const rpcUrl =
    process.env.RPC_URL ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : undefined);
  const wsUrl =
    process.env.WS_URL ?? (heliusKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}` : undefined);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!rpcUrl || !wsUrl) throw new Error("Set HELIUS_API_KEY (or RPC_URL and WS_URL) in .env");
  return {
    databaseUrl: process.env.DATABASE_URL,
    rpcUrl,
    wsUrl,
    snapshotRpcUrl: process.env.SNAPSHOT_RPC_URL ?? rpcUrl,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    rpcRps: num("RPC_RPS", 8),
    binSnapshotIntervalMs: num("BIN_SNAPSHOT_INTERVAL_MS", 45_000),
    metricsIntervalMs: num("METRICS_INTERVAL_MS", 60_000),
    discoveryIntervalMs: num("DISCOVERY_INTERVAL_MS", 300_000),
    gapFillIntervalMs: num("GAP_FILL_INTERVAL_MS", 120_000),
    watchlistSize: num("WATCHLIST_SIZE", 15),
    backfillHours: num("BACKFILL_HOURS", 24),
    snapshotBinsPerSide: num("SNAPSHOT_BINS_PER_SIDE", 70),
  };
}
