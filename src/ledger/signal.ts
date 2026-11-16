import type { HitUsage } from "./transcript.js";

/** Floors the usage table is shown at; rows without injected hits are left out. */
export const SIGNAL_FLOORS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

export interface FloorRow {
  floor: number;
  /** Distinct injected hits scoring at or above the floor. */
  hits: number;
  used: number;
  /** used / hits: how much of what this floor lets through the model went on to touch. */
  precision: number | null;
  /** used / all used hits observed: how much of what got used this floor would still inject. */
  recall: number | null;
}

export interface UsageSignal {
  hits: number;
  used: number;
  byKind: Record<string, number>;
  floors: FloorRow[];
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) / 100 : null);

/**
 * The "used" signal over distinct injected hits. It is a report, not a calibration: only hits at or
 * above the floor in force were ever injected, so it cannot say what a lower floor would add, and a
 * hit counts as used when the model touched its file for any reason, injected or not.
 */
export function usageSignal(hits: HitUsage[]): UsageSignal {
  const isUsed = (h: HitUsage) => h.used.length > 0;
  const used = hits.filter(isUsed).length;
  const byKind: Record<string, number> = {};
  for (const h of hits) for (const k of h.used) byKind[k] = (byKind[k] ?? 0) + 1;
  const floors = SIGNAL_FLOORS.map((floor) => {
    const above = hits.filter((h) => h.score >= floor);
    const kept = above.filter(isUsed).length;
    return { floor, hits: above.length, used: kept, precision: ratio(kept, above.length), recall: ratio(kept, used) };
  }).filter((row) => row.hits > 0);
  return { hits: hits.length, used, byKind, floors };
}
