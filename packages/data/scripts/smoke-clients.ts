// Live smoke test for API clients: pnpm tsx packages/data/scripts/smoke-clients.ts
import { MeteoraDatapi } from "../src/clients/meteora.js";
import { JupiterClient, SOL_MINT } from "../src/clients/jupiter.js";

const datapi = new MeteoraDatapi();
const jup = new JupiterClient(process.env.JUPITER_API_KEY);

const pools = await datapi.listPools({ pageSize: 3, sortBy: "volume_24h:desc" });
console.log(
  "top pools by 24h volume:",
  pools.data.map((p) => `${p.name} tvl=$${Math.round(p.tvl)} vol24h=$${Math.round(p.volume["24h"] ?? 0)}`),
);

const solUsd = await jup.getSolUsd();
console.log("SOL/USD:", solUsd);

const tok = await jup.searchToken(SOL_MINT);
console.log("SOL organicScore:", tok?.organicScore, "holders:", tok?.holderCount);
