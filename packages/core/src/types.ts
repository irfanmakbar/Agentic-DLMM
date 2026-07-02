/** Static fee parameters of an LbPair (sParameters on chain). */
export interface StaticFeeParams {
  baseFactor: number;
  baseFeePowerFactor: number;
  variableFeeControl: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  maxVolatilityAccumulator: number;
  protocolShare: number;
}

/** Dynamic volatility state of an LbPair (vParameters on chain). */
export interface VolatilityState {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: number;
}

/** One bin's liquidity: raw integer token amounts + LP share supply. */
export interface BinState {
  binId: number;
  x: bigint;
  y: bigint;
  supply: bigint;
  /** limit-order liquidity resting in the bin (0 for most pools) */
  loAmount: bigint;
  loAskSide: boolean;
}
