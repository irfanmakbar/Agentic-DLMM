/**
 * GeekLad fee/TVL minimum-projection estimator.
 * Project each window's fee/TVL ratio to a 24h rate, take the minimum across
 * windows, and require volume to be up-trending (short-window annualized volume
 * not collapsing vs the 24h baseline).
 */

export const WINDOW_MINUTES = { "30m": 30, "1h": 60, "2h": 120, "4h": 240, "12h": 720, "24h": 1440 } as const;
export type Window = keyof typeof WINDOW_MINUTES;

export interface GeekladInput {
  /** fee/TVL ratio per window, in percent (as served by Meteora datapi) */
  feeTvlRatio: Partial<Record<Window, number>>;
  /** traded volume per window (USD) */
  volume: Partial<Record<Window, number>>;
}

export interface GeekladEstimate {
  /** per-window fee/TVL projected to a 24h rate (percent) */
  projections: Partial<Record<Window, number>>;
  /** minimum projection across available windows (percent per 24h) */
  minProjection: number | null;
  /** true when projected 1h volume >= 24h volume (activity not collapsing) */
  volumeUptrend: boolean | null;
}

export function geekladEstimate(input: GeekladInput): GeekladEstimate {
  const projections: Partial<Record<Window, number>> = {};
  let min: number | null = null;
  for (const [w, minutes] of Object.entries(WINDOW_MINUTES) as [Window, number][]) {
    const ratio = input.feeTvlRatio[w];
    if (ratio == null) continue;
    const projected = ratio * (WINDOW_MINUTES["24h"] / minutes);
    projections[w] = projected;
    if (min === null || projected < min) min = projected;
  }

  let volumeUptrend: boolean | null = null;
  const vol1h = input.volume["1h"];
  const vol24h = input.volume["24h"];
  if (vol1h != null && vol24h != null && vol24h > 0) {
    volumeUptrend = vol1h * 24 >= vol24h;
  }

  return { projections, minProjection: min, volumeUptrend };
}
