/**
 * DLMM bin/price fixed-point math. Prices are Q64.64 (bigint), amounts are raw
 * integer token units (bigint) — mirrors lb_clmm / @meteora-ag/dlmm exactly.
 */

export const BASIS_POINT_MAX = 10_000;
export const SCALE_OFFSET = 64n;
export const ONE_Q64 = 1n << 64n;
/** fee rates are expressed in 1e9 precision */
export const FEE_PRECISION = 1_000_000_000n;
/** total fee rate cap: 10% */
export const MAX_FEE_RATE = 100_000_000n;

/** floor((x*y) >> offset) or ceil when roundUp */
export function mulShr(x: bigint, y: bigint, roundUp = false): bigint {
  const prod = x * y;
  if (roundUp) return (prod + (ONE_Q64 - 1n)) >> SCALE_OFFSET;
  return prod >> SCALE_OFFSET;
}

/** floor((x << offset) / y) or ceil when roundUp */
export function shlDiv(x: bigint, y: bigint, roundUp = false): bigint {
  const shifted = x << SCALE_OFFSET;
  if (roundUp) return (shifted + y - 1n) / y;
  return shifted / y;
}

const U128_MAX = (1n << 128n) - 1n;
const MAX_EXPONENTIAL = 0x80000n;

/**
 * Q64.64 fixed-point pow, bit-for-bit identical to lb_clmm's utils::math::pow
 * (and the SDK port): bases ≥ 1 are inverted against U128_MAX before the
 * square-and-multiply loop and the result is inverted back at the end.
 */
export function powQ64(base: bigint, exp: number): bigint {
  let invert = exp < 0;
  if (exp === 0) return ONE_Q64;
  let e = BigInt(Math.abs(exp));
  if (e > MAX_EXPONENTIAL) return 0n;

  let squaredBase = base;
  let result = ONE_Q64;
  if (squaredBase >= result) {
    squaredBase = U128_MAX / squaredBase;
    invert = !invert;
  }
  for (let bit = 0n; bit < 19n; bit++) {
    if (e & (1n << bit)) result = (result * squaredBase) >> SCALE_OFFSET;
    squaredBase = (squaredBase * squaredBase) >> SCALE_OFFSET;
  }
  if (result === 0n) return 0n;
  if (invert) result = U128_MAX / result;
  return result;
}

/** Q64.64 price of a bin: (1 + binStep/10000)^binId, exact on-chain math. */
export function qPriceFromId(binId: number, binStep: number): bigint {
  const base = ONE_Q64 + (BigInt(binStep) << SCALE_OFFSET) / BigInt(BASIS_POINT_MAX);
  const price = powQ64(base, binId);
  if (price === 0n) throw new Error(`qPriceFromId underflow for binId ${binId}`);
  return price;
}

/** float price of a bin in raw-units terms (Y per X), for analytics */
export function binPriceRaw(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
}

/** UI price (per-token, decimal adjusted) */
export function binPriceUi(binId: number, binStep: number, xDecimals: number, yDecimals: number): number {
  return binPriceRaw(binId, binStep) * Math.pow(10, xDecimals - yDecimals);
}

export function uiAmount(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

/**
 * Swap output for a given input at a bin price (before fees).
 * swapForY: X in -> Y out = in × P; else Y in -> X out = in / P. Floor.
 */
export function getAmountOut(qPrice: bigint, amountIn: bigint, swapForY: boolean): bigint {
  return swapForY ? mulShr(amountIn, qPrice, false) : shlDiv(amountIn, qPrice, false);
}

/** Input needed to receive amountOut at a bin price (before fees). */
export function getAmountIn(qPrice: bigint, amountOut: bigint, swapForY: boolean, roundUp: boolean): bigint {
  return swapForY ? shlDiv(amountOut, qPrice, roundUp) : mulShr(amountOut, qPrice, roundUp);
}
