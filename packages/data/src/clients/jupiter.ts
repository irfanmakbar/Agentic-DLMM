import { RateLimiter, fetchJson } from "../rateLimiter.js";

export interface JupiterPrice {
  usdPrice: number;
  blockId: number;
  decimals: number;
  priceChange24h: number;
}

export interface JupiterTokenInfo {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  holderCount: number | null;
  mcap: number | null;
  fdv: number | null;
  usdPrice: number | null;
  liquidity: number | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  isVerified: boolean | null;
  tags: string[] | null;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
  } | null;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Jupiter APIs. Keyless requests go to lite-api.jup.ag (rate limited ~1 rps);
 * with an API key requests go to api.jup.ag.
 */
export class JupiterClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly limiter: RateLimiter;

  constructor(apiKey?: string) {
    this.base = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
    this.headers = apiKey ? { "x-api-key": apiKey } : {};
    this.limiter = new RateLimiter(apiKey ? 8 : 0.8);
  }

  /** Max 50 mints per call. Mints without a reliable price are omitted. */
  async getPrices(mints: string[]): Promise<Record<string, JupiterPrice>> {
    const out: Record<string, JupiterPrice> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const batch = mints.slice(i, i + 50);
      await this.limiter.acquire();
      const res = await fetchJson<Record<string, JupiterPrice>>(
        `${this.base}/price/v3?ids=${batch.join(",")}`,
        { headers: this.headers },
      );
      Object.assign(out, res);
    }
    return out;
  }

  async getSolUsd(): Promise<number | null> {
    const prices = await this.getPrices([SOL_MINT]);
    return prices[SOL_MINT]?.usdPrice ?? null;
  }

  /** Token metadata incl. holderCount + organicScore. query = mint or symbol. */
  async searchToken(query: string): Promise<JupiterTokenInfo | null> {
    await this.limiter.acquire();
    const res = await fetchJson<JupiterTokenInfo[]>(
      `${this.base}/tokens/v2/search?query=${encodeURIComponent(query)}`,
      { headers: this.headers },
    );
    return res.find((t) => t.id === query) ?? res[0] ?? null;
  }
}
