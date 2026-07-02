import type { StaticFeeParams } from "@agentic-dlmm/core";

/** Pool facts the engine needs, loaded from the pools table. */
export interface PoolInfo {
  address: string;
  binStep: number;
  tokenXMint: string;
  tokenYMint: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  params: StaticFeeParams;
  /** collect_fee_mode: 0 = input token, 1 = only Y */
  collectFeeMode: number;
  supportsLimitOrder: boolean;
}

/** How to shape the hypothetical position. v0: uniform value per bin. */
export interface PositionSpec {
  /** total deposit value in Y raw units (lamports for SOL-quoted pools) */
  valueY: bigint;
  /** bins below the active bin (Y side) */
  binsBelow: number;
  /** bins above the active bin (X side) */
  binsAbove: number;
}

export interface CostConfig {
  /** priority fee + tip per transaction, in SOL */
  priorityFeePerTxSol: number;
  /** refundable position rent, SOL (returned on close; excluded from net) */
  positionRentSol: number;
  /** non-refundable rent per virgin bin array, SOL */
  binArrayRentSol: number;
  /** number of txs charged (open + close + claim) */
  txCount: number;
}

// Verified live 2026-07-02 via scripts/rent-probe.ts (quoteCreatePosition +
// getMinimumBalanceForRentExemption on mainnet).
export const DEFAULT_COSTS: CostConfig = {
  priorityFeePerTxSol: 0.0002,
  positionRentSol: 0.05740608,
  binArrayRentSol: 0.07143744,
  txCount: 3,
};

/** Decomposed result, mirroring the episodes schema (all in Y units = SOL). */
export interface BacktestResult {
  pool: string;
  from: Date;
  to: Date;
  spec: PositionSpec;
  /** entry state */
  entryActiveBin: number;
  entryPriceRaw: number;
  exitActiveBin: number;
  exitPriceRaw: number;
  /** deposit actually placed (post entry swap), raw units */
  depositX: bigint;
  depositY: bigint;
  /** holdings withdrawn at exit, raw units */
  withdrawnX: bigint;
  withdrawnY: bigint;
  /** LP fees earned, raw units per token */
  feesX: bigint;
  feesY: bigint;
  /** all values below in Y raw units */
  feesValueY: number;
  ilVsHodlY: number;
  entrySwapCostY: number;
  exitSwapCostY: number;
  txFeesY: number;
  binArrayRentY: number;
  netY: number;
  /** value of just HODLing the initial deposit, Y raw units at exit price */
  hodlValueY: number;
  /** exit value of the LP position (holdings + fees), Y raw units */
  exitValueY: number;
  /** replay diagnostics */
  swapsReplayed: number;
  snapshotsResynced: number;
  endBinMismatches: number;
  virginBinArrays: number;
}
