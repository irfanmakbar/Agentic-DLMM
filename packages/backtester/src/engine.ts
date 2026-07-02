import {
  DynamicFeeState,
  binPriceRaw,
  lamportsToSol,
  walkSwapExactIn,
  type BinState,
} from "@agentic-dlmm/core";
import {
  getBinSnapshotAtOrBefore,
  getBinSnapshotsInRange,
  getPool,
  getSwapsInRange,
  type BinSnapshotRow,
  type Db,
  type PoolRow,
  type SwapRow,
} from "@agentic-dlmm/db";
import { binsFromSnapshot, volatilityFromSnapshot } from "./binReconstruction.js";
import { HypotheticalPosition } from "./position.js";
import type { BacktestResult, CostConfig, PoolInfo, PositionSpec } from "./types.js";

const BINS_PER_ARRAY = 70;

export function poolInfoFromRow(row: PoolRow): PoolInfo {
  if (row.base_factor == null) throw new Error(`pool ${row.address} has no on-chain params captured`);
  return {
    address: row.address,
    binStep: row.bin_step,
    tokenXMint: row.token_x_mint,
    tokenYMint: row.token_y_mint,
    tokenXDecimals: row.token_x_decimals ?? 9,
    tokenYDecimals: row.token_y_decimals ?? 9,
    params: {
      baseFactor: row.base_factor,
      baseFeePowerFactor: row.base_fee_power_factor ?? 0,
      variableFeeControl: Number(row.variable_fee_control ?? 0),
      filterPeriod: row.filter_period ?? 0,
      decayPeriod: row.decay_period ?? 0,
      reductionFactor: row.reduction_factor ?? 0,
      maxVolatilityAccumulator: Number(row.max_volatility_accumulator ?? 0),
      protocolShare: row.protocol_share ?? 0,
    },
    collectFeeMode: Number(row.collect_fee_mode ?? 0),
    supportsLimitOrder: row.supports_limit_order ?? false,
  };
}

interface ReplayEvent {
  ts: number;
  kind: "swap" | "snapshot";
  swap?: SwapRow;
  snapshot?: BinSnapshotRow;
}

/** replay one swap event through the reconstructed state */
export function replaySwap(
  pool: PoolInfo,
  bins: Map<number, BinState>,
  feeState: DynamicFeeState,
  swap: SwapRow,
  position: HypotheticalPosition | null,
): { endBinMatched: boolean } {
  const swapForY = swap.swap_for_y;
  // fee side: stored per event when available, else derived from collect mode
  const feeOnInput = swap.fees_on_input ?? (pool.collectFeeMode === 0 ? true : !swapForY);
  const feeOnX = swap.fees_on_token_x ?? (pool.collectFeeMode === 0 ? swapForY : false);

  const res = walkSwapExactIn({
    bins,
    binStep: pool.binStep,
    startBin: swap.start_bin,
    swapForY,
    amountIn: BigInt(swap.amount_in),
    feeState,
    feeOnInput,
    supportsLimitOrder: pool.supportsLimitOrder,
    timestamp: Math.floor(swap.block_ts.getTime() / 1000),
  });

  if (position) {
    for (const fill of res.fills) {
      position.creditFee(fill.binId, fill.lpFee, feeOnX);
    }
  }
  return { endBinMatched: res.endBin === swap.end_bin };
}

/**
 * Swap part of our Y budget into X through the live pool state (entry) or our
 * withdrawn X back into Y (exit), measuring cost = spot value − received.
 * Returns [amountOut, costInY].
 */
function swapThrough(
  pool: PoolInfo,
  bins: Map<number, BinState>,
  feeState: DynamicFeeState,
  activeBin: number,
  amountIn: bigint,
  swapForY: boolean,
  ts: number,
): { out: bigint; costY: number } {
  if (amountIn <= 0n) return { out: 0n, costY: 0 };
  const feeOnInput = pool.collectFeeMode === 0 ? true : !swapForY;
  const res = walkSwapExactIn({
    bins,
    binStep: pool.binStep,
    startBin: activeBin,
    swapForY,
    amountIn,
    feeState: feeState.clone(), // do not disturb the replay's fee state
    feeOnInput,
    supportsLimitOrder: pool.supportsLimitOrder,
    timestamp: ts,
  });
  const spot = binPriceRaw(activeBin, pool.binStep);
  const inValueY = swapForY ? Number(amountIn) * spot : Number(amountIn);
  const outValueY = swapForY ? Number(res.totalAmountOut) : Number(res.totalAmountOut) * spot;
  return { out: res.totalAmountOut, costY: inValueY - outValueY };
}

/** bin arrays our position touches that have zero pool liquidity = assume virgin */
function countVirginBinArrays(bins: Map<number, BinState>, activeBin: number, spec: PositionSpec): number {
  const arrays = new Set<number>();
  for (let binId = activeBin - spec.binsBelow; binId <= activeBin + spec.binsAbove; binId++) {
    arrays.add(Math.floor(binId / BINS_PER_ARRAY));
  }
  let virgin = 0;
  for (const idx of arrays) {
    let hasLiquidity = false;
    for (let b = idx * BINS_PER_ARRAY; b < (idx + 1) * BINS_PER_ARRAY; b++) {
      const bin = bins.get(b);
      if (bin && (bin.supply > 0n || bin.x > 0n || bin.y > 0n)) {
        hasLiquidity = true;
        break;
      }
    }
    if (!hasLiquidity) virgin++;
  }
  return virgin;
}

export interface ReplayOptions {
  pool: string;
  from: Date;
  to: Date;
  spec: PositionSpec;
  costs: CostConfig;
}

/**
 * Replay a hypothetical position over [from, to]:
 * reconstruct bins from the latest snapshot ≤ from, warm the dynamic-fee state
 * and composition with swaps between snapshot and window start, inject the
 * position (fee dilution is structural), replay all swaps crediting our
 * per-bin LP fee share, re-sync at every stored snapshot, and settle at `to`
 * with the full cost model. All SOL-denominated outputs assume Y = SOL.
 */
export async function replayPosition(db: Db, opts: ReplayOptions): Promise<BacktestResult> {
  const poolRow = await getPool(db, opts.pool);
  if (!poolRow) throw new Error(`pool ${opts.pool} not found`);
  const pool = poolInfoFromRow(poolRow);

  const snap0 = await getBinSnapshotAtOrBefore(db, opts.pool, opts.from);
  if (!snap0) throw new Error(`no bin snapshot at or before ${opts.from.toISOString()} for ${opts.pool}`);

  // 1. reconstruct + warm up from snapshot to window start
  let bins = binsFromSnapshot(snap0.bins);
  const feeState = new DynamicFeeState(pool.binStep, pool.params, volatilityFromSnapshot(snap0));
  let activeBin = snap0.active_bin;

  const warmupSwaps = await getSwapsInRange(db, opts.pool, snap0.ts, opts.from);
  for (const s of warmupSwaps) {
    replaySwap(pool, bins, feeState, s, null);
    activeBin = s.end_bin;
  }

  // 2. entry: swap Y->X for the X side, then inject
  const entryPriceRaw = binPriceRaw(activeBin, pool.binStep);
  const totalBins = opts.spec.binsBelow + opts.spec.binsAbove + 1;
  const xSideValueY = (Number(opts.spec.valueY) * (opts.spec.binsAbove + 0.5)) / totalBins;
  const entryTs = Math.floor(opts.from.getTime() / 1000);
  const entrySwap = swapThrough(pool, bins, feeState, activeBin, BigInt(Math.floor(xSideValueY)), false, entryTs);

  const virginBinArrays = countVirginBinArrays(bins, activeBin, opts.spec);

  const position = new HypotheticalPosition(pool.binStep);
  position.inject(bins, activeBin, opts.spec);

  // 3. replay window: swaps + snapshot re-syncs in time order
  const [swaps, snapshots] = await Promise.all([
    getSwapsInRange(db, opts.pool, opts.from, opts.to),
    getBinSnapshotsInRange(db, opts.pool, opts.from, opts.to),
  ]);
  const events: ReplayEvent[] = [
    ...swaps.map((s) => ({ ts: s.block_ts.getTime(), kind: "swap" as const, swap: s })),
    ...snapshots.map((s) => ({ ts: s.ts.getTime(), kind: "snapshot" as const, snapshot: s })),
  ].sort((a, b) => a.ts - b.ts);

  let endBinMismatches = 0;
  let swapsReplayed = 0;
  let snapshotsResynced = 0;

  for (const ev of events) {
    if (ev.kind === "swap" && ev.swap) {
      const { endBinMatched } = replaySwap(pool, bins, feeState, ev.swap, position);
      if (!endBinMatched) endBinMismatches++;
      activeBin = ev.swap.end_bin;
      swapsReplayed++;
    } else if (ev.snapshot) {
      const fresh = binsFromSnapshot(ev.snapshot.bins);
      position.resync(bins, fresh);
      bins = fresh;
      activeBin = ev.snapshot.active_bin;
      const v = volatilityFromSnapshot(ev.snapshot);
      feeState.v.volatilityAccumulator = v.volatilityAccumulator;
      feeState.v.volatilityReference = v.volatilityReference;
      feeState.v.indexReference = v.indexReference;
      feeState.v.lastUpdateTimestamp = v.lastUpdateTimestamp;
      snapshotsResynced++;
    }
  }

  // 4. exit: withdraw holdings (removing our liquidity from the pool state),
  // then swap the X side back to Y through what remains
  const exitPriceRaw = binPriceRaw(activeBin, pool.binStep);
  const holdings = position.withdraw(bins);
  const withdrawnX = holdings.x + position.feesX;
  const withdrawnY = holdings.y + position.feesY;
  const exitTs = Math.floor(opts.to.getTime() / 1000);
  const exitSwap = swapThrough(pool, bins, feeState, activeBin, withdrawnX, true, exitTs);

  const feesValueY = Number(position.feesX) * exitPriceRaw + Number(position.feesY);
  const hodlValueY = Number(position.depositX) * exitPriceRaw + Number(position.depositY);
  const lpHoldingsValueY = Number(holdings.x) * exitPriceRaw + Number(holdings.y);
  const ilVsHodlY = hodlValueY - lpHoldingsValueY;
  const exitValueY = lpHoldingsValueY + feesValueY;

  const lamports = 1e9; // Y assumed SOL for cost conversion
  const txFeesY = opts.costs.priorityFeePerTxSol * opts.costs.txCount * lamports;
  const binArrayRentY = virginBinArrays * opts.costs.binArrayRentSol * lamports;

  const netY = feesValueY - ilVsHodlY - entrySwap.costY - exitSwap.costY - txFeesY - binArrayRentY;

  return {
    pool: opts.pool,
    from: opts.from,
    to: opts.to,
    spec: opts.spec,
    entryActiveBin: snap0.active_bin,
    entryPriceRaw,
    exitActiveBin: activeBin,
    exitPriceRaw,
    depositX: position.depositX,
    depositY: position.depositY,
    withdrawnX,
    withdrawnY,
    feesX: position.feesX,
    feesY: position.feesY,
    feesValueY,
    ilVsHodlY,
    entrySwapCostY: entrySwap.costY,
    exitSwapCostY: exitSwap.costY,
    txFeesY,
    binArrayRentY,
    netY,
    hodlValueY,
    exitValueY,
    swapsReplayed,
    snapshotsResynced,
    endBinMismatches,
    virginBinArrays,
  };
}

export function formatResult(r: BacktestResult): string {
  const sol = (v: number) => lamportsToSol(v).toFixed(6);
  const lines = [
    `pool ${r.pool}  window ${r.from.toISOString()} .. ${r.to.toISOString()}`,
    `entry bin ${r.entryActiveBin} -> exit bin ${r.exitActiveBin}  (price ${r.entryPriceRaw.toExponential(4)} -> ${r.exitPriceRaw.toExponential(4)})`,
    `deposit  X=${r.depositX} Y=${r.depositY}  (spec value ${sol(Number(r.spec.valueY))} SOL over ${r.spec.binsBelow}+1+${r.spec.binsAbove} bins)`,
    `withdraw X=${r.withdrawnX} Y=${r.withdrawnY}`,
    ``,
    `fees earned      ${sol(r.feesValueY)} SOL  (X=${r.feesX} Y=${r.feesY})`,
    `IL vs HODL       ${sol(r.ilVsHodlY)} SOL`,
    `entry swap cost  ${sol(r.entrySwapCostY)} SOL`,
    `exit swap cost   ${sol(r.exitSwapCostY)} SOL`,
    `tx fees          ${sol(r.txFeesY)} SOL`,
    `binArray rent    ${sol(r.binArrayRentY)} SOL  (${r.virginBinArrays} virgin arrays)`,
    `NET              ${sol(r.netY)} SOL`,
    ``,
    `HODL benchmark   ${sol(r.hodlValueY)} SOL  |  LP exit value ${sol(r.exitValueY)} SOL`,
    `replay: ${r.swapsReplayed} swaps, ${r.snapshotsResynced} snapshot re-syncs, ${r.endBinMismatches} end-bin mismatches`,
  ];
  return lines.join("\n");
}
