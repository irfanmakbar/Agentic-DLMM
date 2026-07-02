import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { NewBinSnapshot, NewPool, SnapshotBin } from "@agentic-dlmm/db";
import { dlmm } from "./sdk.js";
import type { RateLimiter } from "./rateLimiter.js";

type DlmmInstance = Awaited<ReturnType<(typeof dlmm)["create"]>>;

/**
 * Cached SDK pool instances for on-chain reads (params + bin snapshots).
 * The SDK makes several internal RPC calls per operation; we approximate the
 * budget by acquiring multiple limiter tokens.
 */
export class PoolStateSource {
  private readonly instances = new Map<string, DlmmInstance>();

  constructor(
    private readonly connection: Connection,
    private readonly limiter: RateLimiter,
  ) {}

  private async acquireN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await this.limiter.acquire();
  }

  async get(pool: string): Promise<DlmmInstance> {
    const existing = this.instances.get(pool);
    if (existing) return existing;
    await this.acquireN(5);
    const instance = await dlmm.create(this.connection, new PublicKey(pool), { cluster: "mainnet-beta" });
    this.instances.set(pool, instance);
    return instance;
  }

  evict(pool: string): void {
    this.instances.delete(pool);
  }

  /** Static pool params from the on-chain LbPair account. */
  async fetchStaticParams(pool: string): Promise<NewPool> {
    const instance = await this.get(pool);
    const lb = instance.lbPair;
    const s = lb.parameters;
    return {
      address: pool,
      tokenXMint: lb.tokenXMint.toBase58(),
      tokenYMint: lb.tokenYMint.toBase58(),
      tokenXDecimals: instance.tokenX.mint.decimals,
      tokenYDecimals: instance.tokenY.mint.decimals,
      binStep: lb.binStep,
      baseFactor: s.baseFactor,
      baseFeePowerFactor: Number(s.baseFeePowerFactor ?? 0),
      variableFeeControl: BigInt(s.variableFeeControl),
      filterPeriod: s.filterPeriod,
      decayPeriod: s.decayPeriod,
      reductionFactor: s.reductionFactor,
      maxVolatilityAccumulator: BigInt(s.maxVolatilityAccumulator),
      protocolShare: s.protocolShare,
      pairType: String(lb.pairType),
      collectFeeMode: String((s as { collectFeeMode?: number }).collectFeeMode ?? 0),
      supportsLimitOrder: dlmm.isSupportLimitOrder(lb),
    };
  }

  /** Live bin-liquidity snapshot ±binsPerSide around the active bin. */
  async snapshot(pool: string, binsPerSide: number): Promise<NewBinSnapshot> {
    const instance = await this.get(pool);
    await this.acquireN(4);
    await instance.refetchStates();
    const { activeBin, bins } = await instance.getBinsAroundActiveBin(binsPerSide, binsPerSide);
    const v = instance.lbPair.vParameters;
    const snapshotBins: SnapshotBin[] = bins.map((b) => {
      const lo = BigInt(b.openOrderAmount.toString()) + BigInt(b.processedOrderRemainingAmount.toString());
      const bin: SnapshotBin = {
        i: b.binId,
        x: b.xAmount.toString(),
        y: b.yAmount.toString(),
        s: b.supply.toString(),
      };
      if (lo > 0n) {
        bin.lo = lo.toString();
        bin.loAsk = b.limitOrderAskSide;
      }
      return bin;
    });
    return {
      pool,
      ts: new Date(),
      slot: null,
      activeBin,
      vAcc: BigInt(v.volatilityAccumulator),
      vRef: BigInt(v.volatilityReference),
      idxRef: v.indexReference,
      lastUpdateTs: BigInt(v.lastUpdateTimestamp.toString()),
      bins: snapshotBins,
    };
  }
}
