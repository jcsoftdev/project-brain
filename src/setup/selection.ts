import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

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

/**
 * Whether a unit is new to this user: a selection file exists, the unit is in neither of its lists,
 * and nothing of it is on disk. The selection file is the record of every id the user was offered,
 * so this needs no per-release list of what shipped when. An installed unit the file never saw
 * (put there by hand, or by the flow before the file existed) is not news.
 */
export function isNewUnit(state: string, seen: Membership, hasSelection: boolean): boolean {
  return hasSelection && seen === "unseen" && state === "absent";
}

/**
 * The ids of a selection merged with the answer for some units only, so a run that offered a
 * subset (`setup --new`) keeps every earlier choice. `decided` are the ids offered this time;
 * an id offered and not chosen becomes declined, an id not offered keeps what it was.
 */
export function mergeSelection(
  prior: Selection | null,
  chosen: string[],
  decided: string[]
): { selected: string[]; allIds: string[] } {
  const offered = new Set(decided);
  const picked = new Set(chosen);
  const keptSelected = (prior?.selected ?? []).filter((id) => !offered.has(id));
  const keptDeclined = (prior?.declined ?? []).filter((id) => !offered.has(id));
  return {
    selected: [...keptSelected, ...decided.filter((id) => picked.has(id))],
    allIds: [...keptSelected, ...keptDeclined, ...decided],
  };
}

const announcedPath = (dataDir: string) => join(dataDir, "whats-new.json");

/** The binary version whose new units were last announced on this machine, or null. */
export async function announcedVersion(dataDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await Bun.file(announcedPath(dataDir)).text()) as { announced?: unknown };
    return typeof parsed.announced === "string" ? parsed.announced : null;
  } catch {
    return null;
  }
}

/** Records that `version`'s new units were announced, so no other session repeats it. */
export async function markAnnounced(dataDir: string, version: string): Promise<void> {
  await writeFileAtomic(announcedPath(dataDir), `${JSON.stringify({ announced: version })}\n`);
}
