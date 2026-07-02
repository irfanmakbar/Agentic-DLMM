import { BorshInstructionCoder } from "@coral-xyz/anchor";
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { BASIS_POINT_MAX, ONE_Q64, SCALE_OFFSET, binPriceRaw, mulShr, powQ64 } from "@agentic-dlmm/core";
import { dlmm, DLMM_PROGRAM_ID } from "@agentic-dlmm/data";

/**
 * Reconstruct the exact per-bin amounts of a deposit by decoding the
 * add-liquidity instruction from the open transaction and mirroring the SDK's
 * strategy -> weight -> amount math (float weights; per-bin floor like the
 * SDK's Decimal.floor). Uniform "spot" spreading is only a fallback — real
 * positions are often BidAsk/Curve shaped and the difference is enormous.
 */

export interface BinDeposit {
  binId: number;
  x: bigint;
  y: bigint;
}

type Weight = { binId: number; weight: number };

const wSpot = (min: number, max: number): Weight[] =>
  range(min, max).map((binId) => ({ binId, weight: 1 }));
const wAsc = (min: number, max: number): Weight[] =>
  range(min, max).map((binId) => ({ binId, weight: binId - min + 1 }));
const wDesc = (min: number, max: number): Weight[] =>
  range(min, max).map((binId) => ({ binId, weight: max - binId + 1 }));

function range(min: number, max: number): number[] {
  const out: number[] = [];
  for (let i = min; i <= max; i++) out.push(i);
  return out;
}

/** bins <= activeId share totalY proportionally to weight */
function amountBidSide(activeId: number, totalY: bigint, ws: Weight[]): BinDeposit[] {
  const totalWeight = ws.reduce((s, w) => (w.binId > activeId ? s : s + w.weight), 0);
  if (totalWeight <= 0) return [];
  return ws.map((w) => ({
    binId: w.binId,
    x: 0n,
    y: w.binId > activeId ? 0n : BigInt(Math.floor((Number(totalY) * w.weight) / totalWeight)),
  }));
}

/** bins >= activeId share totalX proportionally to weight/price */
function amountAskSide(activeId: number, binStep: number, totalX: bigint, ws: Weight[]): BinDeposit[] {
  let totalWeight = 0;
  for (const w of ws) {
    if (w.binId >= activeId) totalWeight += w.weight / binPriceRaw(w.binId, binStep);
  }
  if (totalWeight <= 0) return [];
  return ws.map((w) => {
    if (w.binId < activeId) return { binId: w.binId, x: 0n, y: 0n };
    const wpp = w.weight / binPriceRaw(w.binId, binStep);
    return { binId: w.binId, x: BigInt(Math.floor((Number(totalX) * wpp) / totalWeight)), y: 0n };
  });
}

/** SDK toAmountBothSide: k-scaled two-sided distribution with active-bin split */
function amountBothSide(
  activeId: number,
  binStep: number,
  amountX: bigint,
  amountY: bigint,
  xInActive: bigint,
  yInActive: bigint,
  ws: Weight[],
): BinDeposit[] {
  if (ws.length === 0) return [];
  if (activeId > ws[ws.length - 1]!.binId) return amountBidSide(activeId, amountY, ws);
  if (activeId < ws[0]!.binId) return amountAskSide(activeId, binStep, amountX, ws);

  const active = ws.find((w) => w.binId === activeId);
  const p0 = binPriceRaw(activeId, binStep);
  let wx0 = 0;
  let wy0 = 0;
  if (active) {
    if (xInActive === 0n && yInActive === 0n) {
      wx0 = active.weight / (p0 * 2);
      wy0 = active.weight / 2;
    } else {
      if (xInActive !== 0n) wx0 = active.weight / (p0 + Number(yInActive) / Number(xInActive));
      if (yInActive !== 0n) wy0 = active.weight / (1 + (p0 * Number(xInActive)) / Number(yInActive));
    }
  }
  let totalWeightX = wx0;
  let totalWeightY = wy0;
  for (const w of ws) {
    if (w.binId < activeId) totalWeightY += w.weight;
    if (w.binId > activeId) totalWeightX += w.weight / binPriceRaw(w.binId, binStep);
  }
  const kx = totalWeightX > 0 ? Number(amountX) / totalWeightX : Infinity;
  const ky = totalWeightY > 0 ? Number(amountY) / totalWeightY : Infinity;
  const k = Math.min(kx, ky);
  return ws.map((w) => {
    if (w.binId < activeId) return { binId: w.binId, x: 0n, y: BigInt(Math.floor(k * w.weight)) };
    if (w.binId > activeId) {
      const wpp = w.weight / binPriceRaw(w.binId, binStep);
      return { binId: w.binId, x: BigInt(Math.floor(k * wpp)), y: 0n };
    }
    return { binId: w.binId, x: BigInt(Math.floor(k * wx0)), y: BigInt(Math.floor(k * wy0)) };
  });
}

export type StrategyFamily = "spot" | "curve" | "bidAsk";

/** mirrors SDK toAmountsBothSideByStrategy (per-family weight choice) */
export function strategyDeposits(
  family: StrategyFamily,
  minBinId: number,
  maxBinId: number,
  activeId: number,
  binStep: number,
  amountX: bigint,
  amountY: bigint,
  xInActive: bigint,
  yInActive: bigint,
): BinDeposit[] {
  const singleSideX = amountY === 0n;
  const both = (ws: Weight[]) =>
    amountBothSide(activeId, binStep, amountX, amountY, xInActive, yInActive, ws);

  // out-of-range: one weight ladder over the whole range
  if (activeId < minBinId || activeId > maxBinId) {
    const below = activeId < minBinId; // range entirely above the active bin
    const ws =
      family === "spot"
        ? wSpot(minBinId, maxBinId)
        : family === "curve"
          ? below
            ? wDesc(minBinId, maxBinId)
            : wAsc(minBinId, maxBinId)
          : below
            ? wAsc(minBinId, maxBinId)
            : wDesc(minBinId, maxBinId);
    return both(ws);
  }

  // in-range: separate bid/ask ladders
  const bidW = (lo: number, hi: number) =>
    family === "spot" ? wSpot(lo, hi) : family === "curve" ? wAsc(lo, hi) : wDesc(lo, hi);
  const askW = (lo: number, hi: number) =>
    family === "spot" ? wSpot(lo, hi) : family === "curve" ? wDesc(lo, hi) : wAsc(lo, hi);

  const out: BinDeposit[] = [];
  if (!singleSideX) {
    if (minBinId <= activeId) out.push(...amountBidSide(activeId, amountY, bidW(minBinId, activeId)));
    if (activeId < maxBinId) out.push(...amountAskSide(activeId, binStep, amountX, askW(activeId + 1, maxBinId)));
  } else {
    if (minBinId < activeId) out.push(...amountBidSide(activeId, amountY, bidW(minBinId, activeId - 1)));
    if (activeId <= maxBinId) out.push(...amountAskSide(activeId, binStep, amountX, askW(activeId, maxBinId)));
  }
  return out;
}

/**
 * Expand one rebalance_liquidity `adds` entry (AddLiquidityParams) into
 * per-bin amounts — mirrors SDK toAmountIntoBins / on-chain rebalance math:
 * bid bin y = y0 + deltaY·(activeId − bin); ask bin x = (x0 + deltaX·(bin −
 * activeId)) / price (exact Q64).
 */
export function rebalanceAddDeposits(
  activeId: number,
  binStep: number,
  minDeltaId: number,
  maxDeltaId: number,
  x0: bigint,
  y0: bigint,
  deltaX: bigint,
  deltaY: bigint,
  favorXInActive: boolean,
): BinDeposit[] {
  const base = ONE_Q64 + (BigInt(binStep) << SCALE_OFFSET) / BigInt(BASIS_POINT_MAX);
  const bidY = (binId: number) => y0 + deltaY * BigInt(activeId - binId);
  const askX = (binId: number) => mulShr(x0 + deltaX * BigInt(binId - activeId), powQ64(base, -binId), false);

  const out: BinDeposit[] = [];
  const bidOnly = favorXInActive ? maxDeltaId < 0 : maxDeltaId <= 0;
  const askOnly = favorXInActive ? minDeltaId >= 0 : minDeltaId > 0;
  const bidEnd = bidOnly ? maxDeltaId : favorXInActive ? -1 : 0;
  const askStart = askOnly ? minDeltaId : favorXInActive ? 0 : 1;

  if (!askOnly) {
    for (let d = minDeltaId; d <= bidEnd; d++) {
      out.push({ binId: activeId + d, x: 0n, y: bidY(activeId + d) });
    }
  }
  if (!bidOnly) {
    for (let d = askStart; d <= maxDeltaId; d++) {
      out.push({ binId: activeId + d, x: askX(activeId + d), y: 0n });
    }
  }
  return out;
}

const coder = new BorshInstructionCoder(dlmm.IDL as never);

function asBigint(v: unknown): bigint {
  return BigInt((v as { toString(): string }).toString());
}

function familyOf(strategyType: Record<string, unknown>): StrategyFamily | null {
  const key = Object.keys(strategyType)[0] ?? "";
  if (/^spot/i.test(key)) return "spot";
  if (/^curve/i.test(key)) return "curve";
  if (/^bidask/i.test(key)) return "bidAsk";
  return null;
}

/**
 * Decode all add-liquidity instructions for `position` in a transaction into
 * per-bin deposit amounts. `activeId` and the active bin composition must come
 * from the replay state at the deposit timestamp. Returns null when no
 * supported instruction is found (caller falls back to uniform spread).
 */
export function depositBinsFromTx(
  tx: ParsedTransactionWithMeta,
  position: string,
  binStep: number,
  activeId: number,
  xInActive: bigint,
  yInActive: bigint,
): BinDeposit[] | null {
  const instructions: PartiallyDecodedInstruction[] = [];
  const collect = (ix: unknown) => {
    const pix = ix as PartiallyDecodedInstruction;
    if ("data" in (pix as object) && pix.programId?.toBase58() === DLMM_PROGRAM_ID) instructions.push(pix);
  };
  for (const ix of tx.transaction.message.instructions) collect(ix);
  for (const group of tx.meta?.innerInstructions ?? []) for (const ix of group.instructions) collect(ix);

  const out: BinDeposit[] = [];
  let found = false;
  for (const pix of instructions) {
    if (pix.accounts[0]?.toBase58() !== position) continue; // position is account 0 of all add_liquidity*
    let decoded: { name: string; data: Record<string, unknown> } | null = null;
    try {
      decoded = coder.decode(Buffer.from(bs58.decode(pix.data))) as {
        name: string;
        data: Record<string, unknown>;
      } | null;
    } catch {
      continue;
    }
    if (!decoded) continue;

    if (decoded.name === "add_liquidity_by_strategy" || decoded.name === "add_liquidity_by_strategy2") {
      const p = decoded.data.liquidity_parameter as Record<string, unknown>;
      const sp = p.strategy_parameters as Record<string, unknown>;
      const family = familyOf(sp.strategy_type as Record<string, unknown>);
      if (!family) continue;
      out.push(
        ...strategyDeposits(
          family,
          Number(sp.min_bin_id),
          Number(sp.max_bin_id),
          activeId,
          binStep,
          asBigint(p.amount_x),
          asBigint(p.amount_y),
          xInActive,
          yInActive,
        ),
      );
      found = true;
    } else if (decoded.name === "add_liquidity" || decoded.name === "add_liquidity2") {
      // exact per-bin distribution in BPS of the totals
      const p = decoded.data.liquidity_parameter as Record<string, unknown>;
      const amountX = asBigint(p.amount_x);
      const amountY = asBigint(p.amount_y);
      const dist = p.bin_liquidity_dist as Array<Record<string, unknown>>;
      for (const d of dist) {
        out.push({
          binId: Number(d.bin_id),
          x: (amountX * asBigint(d.distribution_x)) / 10_000n,
          y: (amountY * asBigint(d.distribution_y)) / 10_000n,
        });
      }
      found = true;
    } else if (decoded.name === "rebalance_liquidity") {
      const p = decoded.data.params as Record<string, unknown>;
      const rebActive = Number(p.active_id);
      for (const add of (p.adds as Array<Record<string, unknown>>) ?? []) {
        const bitFlag = Number(add.bit_flag);
        const sign = (bit: number) => (bitFlag & bit ? -1n : 1n);
        out.push(
          ...rebalanceAddDeposits(
            rebActive,
            binStep,
            Number(add.min_delta_id),
            Number(add.max_delta_id),
            sign(1) * asBigint(add.x0),
            sign(2) * asBigint(add.y0),
            sign(4) * asBigint(add.delta_x),
            sign(8) * asBigint(add.delta_y),
            add.favor_x_in_active_id as boolean,
          ),
        );
        found = true;
      }
      if (((p.removes as unknown[]) ?? []).length > 0) {
        // withdrawals are handled from datapi remove events (proportional);
        // per-bin remove decoding is not implemented
      }
    }
  }
  return found ? out : null;
}
