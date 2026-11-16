import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
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

  // Atomic: the prompt hook reads this file, and a half-written one would read as "no selection".
  await writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * The saved selection, telling a file that is not there (`missing`: setup never ran) from one that
 * could not be read (`unreadable`: corrupt, or caught mid-write). Only the first means "nothing is
 * new"; the second means "unknown, ask again later".
 */
export async function readSelection(
  path: string
): Promise<{ kind: "ok"; selection: Selection } | { kind: "missing" } | { kind: "unreadable" }> {
  if (!existsSync(path)) return { kind: "missing" };
  const selection = await loadSelection(path);
  return selection ? { kind: "ok", selection } : { kind: "unreadable" };
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

export interface AnnouncedUnit {
  id: string;
  label: string;
  description: string;
}

/**
 * The new units of one binary version, computed between sessions (`maintain`, `update`) so the
 * prompt hook only reads a file. `unknown` are units whose inspection did not answer in time: they
 * are not listed, and the next computation looks at them again.
 */
export interface WhatsNewCache {
  version: string;
  units: AnnouncedUnit[];
  unknown: string[];
}

const cachePath = (dataDir: string) => join(dataDir, "whats-new.json");
const announcedPath = (dataDir: string) => join(dataDir, "whats-new-announced.json");

export async function readWhatsNewCache(dataDir: string): Promise<WhatsNewCache | null> {
  try {
    const parsed = JSON.parse(await Bun.file(cachePath(dataDir)).text()) as Partial<WhatsNewCache>;
    if (typeof parsed.version !== "string" || !Array.isArray(parsed.units) || !Array.isArray(parsed.unknown)) return null;
    return { version: parsed.version, units: parsed.units, unknown: parsed.unknown };
  } catch {
    return null;
  }
}

export async function writeWhatsNewCache(dataDir: string, cache: WhatsNewCache): Promise<void> {
  await writeFileAtomic(cachePath(dataDir), `${JSON.stringify(cache)}\n`);
}

/** Every unit id ever announced on this machine: each is announced at most once, whatever the release. */
export async function announcedIds(dataDir: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await Bun.file(announcedPath(dataDir)).text()) as { ids?: unknown };
    return new Set(Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export async function recordAnnounced(dataDir: string, ids: string[]): Promise<void> {
  const all = new Set([...(await announcedIds(dataDir)), ...ids]);
  await writeFileAtomic(announcedPath(dataDir), `${JSON.stringify({ ids: [...all] })}\n`);
}

/**
 * Claims one announcement before it is printed, so of two sessions prompting at once only one
 * shows it. Exclusive create on a name made of the version and the ids: the same list in the same
 * release is claimed once, while a unit found later in that release makes a new list and a new claim.
 */
export async function claimAnnouncement(dataDir: string, version: string, ids: string[]): Promise<boolean> {
  const dir = join(dataDir, "whats-new-claims");
  await mkdir(dir, { recursive: true });
  const key = Bun.hash([...ids].sort().join(",")).toString(36);
  try {
    await (await open(join(dir, `${version}-${key}`), "wx")).close();
    return true;
  } catch {
    return false;
  }
}
