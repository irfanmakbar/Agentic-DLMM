import { Command } from "commander";
import { Connection } from "@solana/web3.js";
import {
  createDb,
  getPool as getPoolRow,
  getSwapsInRange,
  getBinSnapshotAtOrBefore,
  getBinSnapshotsInRange,
} from "@agentic-dlmm/db";
import { MeteoraDatapi } from "@agentic-dlmm/data";
import { DEFAULT_COSTS } from "./types.js";
import { formatResult, poolInfoFromRow, replayPosition } from "./engine.js";
import { feeResidualReport } from "./calibration/feeResiduals.js";
import { replayThirdPartyPosition } from "./calibration/positionReplay.js";
import { volatilityFromSnapshot } from "./binReconstruction.js";
import { compare, register, track } from "./validation.js";

if (process.env.DATABASE_URL == null) {
  try {
    process.loadEnvFile();
  } catch {
    // no .env — rely on the environment
  }
}

const program = new Command("backtest");

/** RPC connection for deposit-shape decoding; null when no RPC configured */
function rpcConnection(): Connection | null {
  const url =
    process.env.RPC_URL ??
    (process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : null);
  return url ? new Connection(url, "confirmed") : null;
}

program
  .command("replay")
  .description("Replay a hypothetical uniform position over a captured window")
  .requiredOption("--pool <address>", "LbPair address (must be captured)")
  .requiredOption("--from <iso>", "window start (ISO timestamp)")
  .requiredOption("--to <iso>", "window end (ISO timestamp)")
  .option("--value-sol <n>", "deposit value in SOL", "0.5")
  .option("--bins-below <n>", "bins below the active bin", "10")
  .option("--bins-above <n>", "bins above the active bin", "10")
  .option("--priority-fee-sol <n>", "priority fee per tx in SOL", String(DEFAULT_COSTS.priorityFeePerTxSol))
  .option("--tx-count <n>", "transactions charged", String(DEFAULT_COSTS.txCount))
  .option("--json", "output JSON instead of text")
  .action(async (o) => {
    const db = createDb();
    try {
      const result = await replayPosition(db, {
        pool: o.pool,
        from: new Date(o.from),
        to: new Date(o.to),
        spec: {
          valueY: BigInt(Math.floor(Number(o.valueSol) * 1e9)),
          binsBelow: Number(o.binsBelow),
          binsAbove: Number(o.binsAbove),
        },
        costs: {
          ...DEFAULT_COSTS,
          priorityFeePerTxSol: Number(o.priorityFeeSol),
          txCount: Number(o.txCount),
        },
      });
      if (o.json) {
        console.log(
          JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
        );
      } else {
        console.log(formatResult(result));
      }
    } finally {
      await db.end();
    }
  });

program
  .command("calibrate-fees")
  .description("Tier-1: per-swap fee_bps residuals of the dynamic-fee simulator")
  .requiredOption("--pool <address>", "LbPair address")
  .option("--from <iso>", "window start", "1970-01-01")
  .option("--to <iso>", "window end", "2100-01-01")
  .action(async (o) => {
    const db = createDb();
    try {
      const poolRow = await getPoolRow(db, o.pool);
      if (!poolRow) throw new Error(`pool ${o.pool} not found`);
      const pool = poolInfoFromRow(poolRow);
      const from = new Date(o.from);
      const to = new Date(o.to);
      const swaps = await getSwapsInRange(db, o.pool, from, to);
      const usable = swaps.filter((s) => s.fee_bps != null);
      if (usable.length === 0) throw new Error("no captured swaps with fee_bps in window");

      const snap = await getBinSnapshotAtOrBefore(db, o.pool, new Date(usable[0]!.block_ts.getTime()));
      const seed = snap ? volatilityFromSnapshot(snap) : undefined;
      // every stored snapshot carries the on-chain volatility state: use them
      // as checkpoints so reference drift from capture gaps self-heals
      const snapshots = await getBinSnapshotsInRange(
        db,
        o.pool,
        snap?.ts ?? from,
        new Date(usable[usable.length - 1]!.block_ts.getTime()),
      );
      const checkpoints = snapshots
        .filter((s) => s.last_update_ts != null)
        .map((s) => ({ ts: Math.floor(s.ts.getTime() / 1000), state: volatilityFromSnapshot(s) }));

      const report = feeResidualReport(
        pool.binStep,
        pool.params,
        usable.map((s) => ({
          sig: s.sig,
          startBin: s.start_bin,
          endBin: s.end_bin,
          ts: Math.floor(s.block_ts.getTime() / 1000),
          feeBps: s.fee_bps!,
        })),
        seed,
        checkpoints,
      );
      console.log(`checkpoints used: ${checkpoints.length}`);
      const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
      console.log(`pool ${o.pool}  swaps=${usable.length}  seeded=${report.seededFrom}  warmup skipped=${report.warmupSkipped}`);
      for (const [name, st] of [["start-bin", report.startBin], ["end-bin", report.endBin]] as const) {
        console.log(
          `${name}: n=${st.n} exact=${st.exact} (${st.n > 0 ? ((100 * st.exact) / st.n).toFixed(1) : 0}%)  ` +
            `p50=${pct(st.p50)} p90=${pct(st.p90)} p99=${pct(st.p99)} max=${pct(st.max)}`,
        );
        for (const w of st.worst.filter((x) => x.rel > 0).slice(0, 3)) {
          console.log(`  worst: ${w.sig.slice(0, 16)}… pred=${w.predicted} obs=${w.observed} rel=${pct(w.rel)}`);
        }
      }
    } finally {
      await db.end();
    }
  });

program
  .command("replay-position")
  .description("Tier-2: replay a real position and compare predicted vs claimed fees")
  .requiredOption("--position <address>", "position pubkey")
  .option("--lower-bin <n>", "position lower bin id")
  .option("--upper-bin <n>", "position upper bin id")
  .action(async (o) => {
    const db = createDb();
    try {
      const datapi = new MeteoraDatapi();
      const res = await replayThirdPartyPosition(
        db,
        datapi,
        o.position,
        o.lowerBin != null && o.upperBin != null
          ? { lower: Number(o.lowerBin), upper: Number(o.upperBin) }
          : undefined,
        rpcConnection() ?? undefined,
      );
      console.log(`position ${res.position} pool ${res.pool}`);
      console.log(`window ${res.window.from.toISOString()} .. ${res.window.to.toISOString()}`);
      console.log(`predicted fees X=${res.predictedFeesX} Y=${res.predictedFeesY}`);
      console.log(`claimed   fees X=${res.claimedFeesX} Y=${res.claimedFeesY}`);
      console.log(`fee error: ${res.feeErrorPct == null ? "n/a (no claims)" : res.feeErrorPct.toFixed(2) + "%"}`);
      console.log(`withdrawn  predicted X=${res.predictedWithdrawnX} Y=${res.predictedWithdrawnY}`);
      console.log(`withdrawn  realized  X=${res.withdrawnX} Y=${res.withdrawnY}`);
      const y = (v: number | null) => (v == null ? "n/a" : (v / 1e9).toFixed(9) + " Y");
      console.log(`IL vs HODL predicted=${y(res.predictedIlY)} realized=${y(res.realizedIlY)}`);
      console.log(`IL error: ${res.ilErrorPct == null ? "n/a" : res.ilErrorPct.toFixed(2) + "%"}`);
      console.log(`replay: ${res.swapsReplayed} swaps, ${res.snapshotsResynced} snapshot re-syncs`);
      for (const n of res.notes) console.log(`note: ${n}`);
    } finally {
      await db.end();
    }
  });

const validation = program.command("validation").description("Tier-3 live validation positions");

validation
  .command("register")
  .description("Register a manually opened position for tracking")
  .requiredOption("--pool <address>", "LbPair address")
  .requiredOption("--position <address>", "position pubkey")
  .option("--wallet <address>", "owner wallet")
  .option("--notes <text>", "free-form notes")
  .action(async (o) => {
    const db = createDb();
    try {
      await register(db, { pool: o.pool, positionPubkey: o.position, wallet: o.wallet, notes: o.notes });
      console.log(`registered ${o.position} on ${o.pool} — its pool is pinned into capture on the next discovery round`);
    } finally {
      await db.end();
    }
  });

validation
  .command("track")
  .description("Update open/close status from captured events")
  .action(async () => {
    const db = createDb();
    try {
      const outcomes = await track(db);
      for (const t of outcomes) {
        console.log(
          `${t.position}  status=${t.status}  open=${t.openTs?.toISOString() ?? "-"}  close=${t.closeTs?.toISOString() ?? "-"}`,
        );
      }
      if (outcomes.length === 0) console.log("no validation positions registered");
    } finally {
      await db.end();
    }
  });

validation
  .command("compare")
  .description("Replay closed positions; store predicted vs realized per component")
  .option("--position <address>", "compare only this position")
  .action(async (o) => {
    const db = createDb();
    try {
      const outcomes = await compare(db, new MeteoraDatapi(), o.position, rpcConnection() ?? undefined);
      for (const c of outcomes) {
        console.log(
          `${c.position}  feeError=${c.feeErrorPct == null ? "n/a" : c.feeErrorPct.toFixed(2) + "%"}  ` +
            `ilError=${c.ilErrorPct == null ? "n/a" : c.ilErrorPct.toFixed(2) + "%"}`,
        );
        for (const n of c.notes) console.log(`  note: ${n}`);
      }
      if (outcomes.length === 0) console.log("no closed validation positions to compare");
    } finally {
      await db.end();
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
