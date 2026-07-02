/** Simple token-bucket rate limiter shared by API/RPC callers. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly burst: number;

  constructor(private readonly ratePerSec: number, burst?: number) {
    this.burst = Math.max(1, burst ?? ratePerSec);
    this.tokens = this.burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.ratePerSec) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
    }
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${await res.text()}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}
