/**
 * Open pages of the shared browser, as the bridge reports them.
 *
 * `list_pages` returns one line per page (`<id>: <title> (<url>) [selected]`) and nothing else:
 * no age, no last use, no owner, and no isolatedContext name. So there is no way to tell a page
 * that belongs to a dead session from one that belongs to a live one. The only honest age is
 * "first seen by this tool", recorded across runs of `browser status` and `browser prune-pages`,
 * which is a lower bound. That is why pruning is dry-run by default and needs --yes.
 */

export interface Page {
  id: number;
  label: string;
  selected: boolean;
}

export function parsePages(text: string): Page[] {
  const pages: Page[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+):\s+(.*?)(\s+\[selected\])?\s*$/);
    if (m) pages.push({ id: +m[1]!, label: m[2]!, selected: Boolean(m[3]) });
  }
  return pages;
}

/** First-seen times per page, keyed by server pid so a restarted server starts clean. */
export type SeenState = Record<string, number>;

const key = (serverPid: number, id: number) => `${serverPid}:${id}`;

/** Record newly seen pages and forget the ones that are gone. */
export function recordSeen(state: SeenState, serverPid: number, pages: Page[], now: number): SeenState {
  const next: SeenState = {};
  for (const p of pages) next[key(serverPid, p.id)] = state[key(serverPid, p.id)] ?? now;
  return next;
}

/**
 * Pages worth asking about: seen for at least `olderThanMs`, excluding the selected page and the
 * most recently first-seen one (the likeliest to be in use right now).
 */
export function stalePages(pages: Page[], state: SeenState, serverPid: number, now: number, olderThanMs: number): Page[] {
  const seen = (p: Page) => state[key(serverPid, p.id)] ?? now;
  const newest = [...pages].sort((a, b) => seen(b) - seen(a) || b.id - a.id)[0];
  return pages.filter((p) => !p.selected && p !== newest && now - seen(p) >= olderThanMs);
}

export type PruneDecision =
  | { kind: "refuse"; reason: string }
  | { kind: "dry-run"; pages: Page[] }
  | { kind: "close"; pages: Page[] };

/**
 * Closing is allowed only on the browser this tool launched (`headless-profile`): on an
 * autoConnect server the pages are the owner's own tabs, and on a foreign one nothing is known.
 * Even then it closes only with explicit confirmation.
 */
export function decidePrune(mode: string, stale: Page[], confirmed: boolean): PruneDecision {
  if (mode !== "headless-profile") {
    return {
      kind: "refuse",
      reason: `the shared server is in ${mode} mode; its pages may be your own tabs, so none are closed from here`,
    };
  }
  return confirmed ? { kind: "close", pages: stale } : { kind: "dry-run", pages: stale };
}

/** `90s`, `30m`, `2h`, `1d` to milliseconds, or null. */
export function parseDuration(text: string): number | null {
  const m = text.match(/^(\d+)([smhd])$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"];
}
