/**
 * The size past which the shared server is worth restarting.
 *
 * This only DECIDES; it never restarts. There is no reliable idle signal to restart on: every
 * open session holds a persistent connection to the bridge (verified with `lsof` on the bridge
 * port), and the bridge exposes no activity timestamp, so "no connections" never happens while
 * any session is open and "no traffic" cannot be observed from outside. A restart on a guess
 * would cut a running session's browser, so the budget is surfaced and the restart stays the
 * owner's, with the exact command the service unit prints.
 */

export const DEFAULT_MAX_MB = 1024;

export function maxMb(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BRAIN_CHROME_SERVER_MAX_MB);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MB;
}

export interface Budget {
  rssMb: number;
  maxMb: number;
  over: boolean;
}

export function assess(rssKb: number, max: number): Budget {
  const rssMb = Math.round(rssKb / 1024);
  return { rssMb, maxMb: max, over: rssMb > max };
}
