import { binPriceRaw, type BinState } from "@agentic-dlmm/core";
import type { PositionSpec } from "./types.js";

/**
 * Hypothetical position injected into the replayed pool state.
 *
 * Per bin we hold a fixed share s_b of the bin (value-proportional at
 * injection, mirroring supply-share minting). Holdings are always
 * s_b × current bin composition; LP fees accrue separately (lb_clmm does not
 * compound fees into bins). Injecting our amounts into the pool bins makes
 * fee-share dilution structural: subsequent fills split fees over
 * pool + our liquidity automatically.
 */
/** on-chain liquidity supply scale: supply ≈ (x·price + y) « 64 */
export const SUPPLY_SCALE = 2 ** 64;

export class HypotheticalPosition {
  /** binId -> our share of the bin's supply (0..1), fixed at injection */
  readonly shares = new Map<number, number>();
  /**
   * binId -> our absolute supply units (on-chain scale, float). Constant
   * between our own deposits/withdrawals — the exact quantity lb_clmm tracks —
   * so shares re-derived from snapshot supply are immune to composition drift.
   */
  readonly supplyUnits = new Map<number, number>();
  feesX = 0n;
  feesY = 0n;
  depositX = 0n;
  depositY = 0n;

  /**
   * snapshotsIncludeUs: the position really exists on-chain, so any snapshot
   * taken after its deposit already contains its liquidity — `resync` must not
   * re-add our holdings (double-count); it only re-derives the share.
   * Deposits themselves still mutate bins: the pre-deposit state doesn't
   * include us yet.
   */
  constructor(
    readonly binStep: number,
    readonly snapshotsIncludeUs = false,
  ) {}

  /**
   * Spread `spec.valueY` uniformly across [active−binsBelow, active+binsAbove]:
   * Y below the active bin, X above, active bin split 50/50. Mutates `bins`
   * (adds our amounts) and records our share per bin.
   */
  inject(bins: Map<number, BinState>, activeBin: number, spec: PositionSpec): void {
    const totalBins = spec.binsBelow + spec.binsAbove + 1;
    const valuePerBin = Number(spec.valueY) / totalBins;

    for (let binId = activeBin - spec.binsBelow; binId <= activeBin + spec.binsAbove; binId++) {
      const price = binPriceRaw(binId, this.binStep);
      let addX = 0n;
      let addY = 0n;
      if (binId < activeBin) {
        addY = BigInt(Math.floor(valuePerBin));
      } else if (binId > activeBin) {
        addX = BigInt(Math.floor(valuePerBin / price));
      } else {
        addY = BigInt(Math.floor(valuePerBin / 2));
        addX = BigInt(Math.floor(valuePerBin / 2 / price));
      }
      if (addX === 0n && addY === 0n) continue;

      let bin = bins.get(binId);
      if (!bin) {
        bin = { binId, x: 0n, y: 0n, supply: 0n, loAmount: 0n, loAskSide: false };
        bins.set(binId, bin);
      }
      const poolValue = Number(bin.x) * price + Number(bin.y);
      const ourValue = Number(addX) * price + Number(addY);
      bin.x += addX;
      bin.y += addY;
      this.shares.set(binId, ourValue / (poolValue + ourValue));
      this.depositX += addX;
      this.depositY += addY;
    }
  }

  /**
   * Deposit exact per-bin amounts (real-position replay). Mutates the bin
   * (tokens really enter the pool) and mints supply units at on-chain scale:
   * minted = ourValue/poolValue × preSupply, or value×2^64 for a virgin bin.
   */
  deposit(bins: Map<number, BinState>, binId: number, addX: bigint, addY: bigint): void {
    if (addX === 0n && addY === 0n) return;
    let bin = bins.get(binId);
    if (!bin) {
      bin = { binId, x: 0n, y: 0n, supply: 0n, loAmount: 0n, loAskSide: false };
      bins.set(binId, bin);
    }
    const price = binPriceRaw(binId, this.binStep);
    const poolValue = Number(bin.x) * price + Number(bin.y);
    const ourValue = Number(addX) * price + Number(addY);
    const preSupply = Number(bin.supply);
    const minted = poolValue > 0 && preSupply > 0 ? (ourValue / poolValue) * preSupply : ourValue * SUPPLY_SCALE;

    const prevShare = this.shares.get(binId) ?? 0;
    this.shares.set(binId, (poolValue * prevShare + ourValue) / (poolValue + ourValue));
    this.supplyUnits.set(binId, (this.supplyUnits.get(binId) ?? 0) + minted);
    bin.x += addX;
    bin.y += addY;
    bin.supply = BigInt(Math.floor(preSupply + minted));
    this.depositX += addX;
    this.depositY += addY;
  }

  /** Credit our slice of a fill's LP fee (fee token decided by the caller). */
  creditFee(binId: number, lpFee: bigint, feeOnX: boolean): void {
    const s = this.shares.get(binId);
    if (!s || lpFee === 0n) return;
    const ours = BigInt(Math.floor(Number(lpFee) * s));
    if (feeOnX) this.feesX += ours;
    else this.feesY += ours;
  }

  /** Our current holdings = share × bin composition, summed over our bins. */
  holdings(bins: Map<number, BinState>): { x: bigint; y: bigint } {
    let x = 0n;
    let y = 0n;
    for (const [binId, s] of this.shares) {
      const bin = bins.get(binId);
      if (!bin) continue;
      x += BigInt(Math.floor(Number(bin.x) * s));
      y += BigInt(Math.floor(Number(bin.y) * s));
    }
    return { x, y };
  }

  /**
   * Remove a fraction (default all) of our holdings from the pool state.
   * Per bin: removing fraction f of our slice shrinks the bin, so the
   * remaining share becomes s(1−f) / (1 − f·s).
   */
  withdraw(bins: Map<number, BinState>, fraction = 1): { x: bigint; y: bigint } {
    let x = 0n;
    let y = 0n;
    for (const [binId, s] of this.shares) {
      const bin = bins.get(binId);
      if (!bin) continue;
      const outX = BigInt(Math.floor(Number(bin.x) * s * fraction));
      const outY = BigInt(Math.floor(Number(bin.y) * s * fraction));
      bin.x -= outX;
      bin.y -= outY;
      x += outX;
      y += outY;
      const u = this.supplyUnits.get(binId);
      if (u != null) this.supplyUnits.set(binId, u * (1 - fraction));
      if (fraction >= 1) continue;
      this.shares.set(binId, (s * (1 - fraction)) / (1 - fraction * s));
    }
    if (fraction >= 1) {
      this.shares.clear();
      this.supplyUnits.clear();
    }
    return { x, y };
  }

  /**
   * Snapshot re-sync: remove our holdings from the outgoing state, replace the
   * pool bins with the fresh snapshot, then re-add our holdings and recompute
   * shares. Keeps our position across re-syncs while adopting the pool's true
   * composition (liquidity add/removes between snapshots are the known
   * approximation).
   */
  resync(oldBins: Map<number, BinState>, freshBins: Map<number, BinState>): void {
    const newShares = new Map<number, number>();
    for (const [binId, s] of this.shares) {
      const old = oldBins.get(binId);
      if (!old) continue;
      const ourX = BigInt(Math.floor(Number(old.x) * s));
      const ourY = BigInt(Math.floor(Number(old.y) * s));
      if (ourX === 0n && ourY === 0n) continue;

      const fresh = freshBins.get(binId);
      if (!fresh) {
        // bin outside the snapshot's capture window (far from the active bin):
        // carry the old state — pool + us — forward wholesale
        freshBins.set(binId, old);
        newShares.set(binId, s);
        continue;
      }
      const price = binPriceRaw(binId, this.binStep);
      const poolValue = Number(fresh.x) * price + Number(fresh.y);
      const ourValue = Number(ourX) * price + Number(ourY);
      if (this.snapshotsIncludeUs) {
        // fresh snapshot already contains us: share = our supply / snapshot supply
        const u = this.supplyUnits.get(binId);
        if (u != null && fresh.supply > 0n) {
          newShares.set(binId, Math.min(1, u / Number(fresh.supply)));
        } else {
          // supply unknown (bin outside snapshot range): carry the share forward
          newShares.set(binId, s);
        }
      } else {
        fresh.x += ourX;
        fresh.y += ourY;
        newShares.set(binId, ourValue === 0 ? 0 : ourValue / (poolValue + ourValue));
      }
    }
    this.shares.clear();
    for (const [k, v] of newShares) this.shares.set(k, v);
  }
}
