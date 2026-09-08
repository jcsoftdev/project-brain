import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where a unit stands with this user.
 *
 * The third value is the load-bearing one. A unit in NEITHER list has never
 * been offered — it shipped after the last setup run — so it is presented
 * unchecked and marked new. With a single list, "I declined this" and "this did
 * not exist last time" would be the same absence, which is exactly the
 * ambiguity that forced `refreshStaleSkills` to add skills nobody asked for.
 */
export type Membership = "selected" | "declined" | "unseen";

export interface Selection {
  version: 1;
  /** ISO timestamp of the run that wrote this file. */
  updatedAt: string;
  /** The project-brain version that wrote it, shown on the next run's header. */
  binaryVersion: string;
  selected: string[];
  declined: string[];
}

/**
 * Read the saved selection, or `null` when there is none.
 *
 * A corrupt or unreadable file reads as `null`, which means "never chosen" and
 * therefore reproduces first-run behaviour. Failing that direction is safe:
 * the worst case is that the user is asked again.
 */
export async function loadSelection(path: string): Promise<Selection | null> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as Partial<Selection>;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.selected) || !Array.isArray(parsed.declined)) return null;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      binaryVersion: typeof parsed.binaryVersion === "string" ? parsed.binaryVersion : "",
      selected: parsed.selected.filter((id): id is string => typeof id === "string"),
      declined: parsed.declined.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    return null;
  }
}

/**
 * Persist a selection.
 *
 * `declined` is derived here rather than passed in, from `allIds` minus
 * `selected`, so the two lists cannot drift apart: every id the user was shown
 * lands in exactly one of them, and anything absent from both is genuinely a
 * unit that did not exist when this ran.
 */
export async function saveSelection(
  path: string,
  selected: string[],
  allIds: string[],
  binaryVersion: string
): Promise<void> {
  const chosen = new Set(selected);
  const payload: Selection = {
    version: 1,
    updatedAt: new Date().toISOString(),
    binaryVersion,
    selected: allIds.filter((id) => chosen.has(id)),
    declined: allIds.filter((id) => !chosen.has(id)),
  };

  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Where one unit stands. Everything is `unseen` when nothing was ever saved. */
export function membership(selection: Selection | null, id: string): Membership {
  if (!selection) return "unseen";
  if (selection.selected.includes(id)) return "selected";
  if (selection.declined.includes(id)) return "declined";
  return "unseen";
}
