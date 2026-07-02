import { binPriceRaw } from "./binMath.js";

/**
 * SOL-denominated valuation helpers. Pools we trade quote SOL as token Y, so
 * "value in Y raw units" is lamports; divide by 1e9 for SOL. Float64 is fine
 * at our precision target (≤15% replay error).
 */

export interface BinAmounts {
  binId: number;
  x: bigint;
  y: bigint;
}

/** value of a set of per-bin amounts, in Y raw units */
export function valueInY(bins: Iterable<BinAmounts>, binStep: number): number {
  let total = 0;
  for (const b of bins) {
    total += Number(b.x) * binPriceRaw(b.binId, binStep) + Number(b.y);
  }
  return total;
}

/** value of a single (x, y) holding at a given bin price, in Y raw units */
export function holdingValueInY(x: bigint, y: bigint, priceRaw: number): number {
  return Number(x) * priceRaw + Number(y);
}

export const LAMPORTS_PER_SOL = 1e9;

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}
