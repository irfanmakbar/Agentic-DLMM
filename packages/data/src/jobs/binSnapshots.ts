import { type Db, getWatchlistedPools, insertBinSnapshot } from "@agentic-dlmm/db";
import { log } from "../log.js";
import type { PoolStateSource } from "../poolState.js";

export class BinSnapshotter {
  constructor(
    private readonly db: Db,
    private readonly poolState: PoolStateSource,
    private readonly binsPerSide: number,
  ) {}

  async run(): Promise<void> {
    const pools = await getWatchlistedPools(this.db);
    for (const pool of pools) {
      try {
        const snapshot = await this.poolState.snapshot(pool.address, this.binsPerSide);
        await insertBinSnapshot(this.db, snapshot);
      } catch (err) {
        log.warn({ pool: pool.address, err: (err as Error).message }, "bin snapshot failed");
        this.poolState.evict(pool.address); // force clean re-create next round
      }
    }
    log.debug({ pools: pools.length }, "bin snapshot round complete");
  }
}
