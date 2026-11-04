import { DB_PATH } from "../constants.js";
import { LanceDbStore } from "../store/lancedb.js";
import { dirSize, lsofTableHolders, tablePath } from "./auto-compact.js";

/** Versions younger than this survive a compaction. Minutes, not days: the
 *  point of running this by hand is to reclaim what routine maintenance
 *  deliberately keeps. */
const AGGRESSIVE_RETENTION_MS = 10 * 60 * 1000;

const gb = (bytes: number) => (bytes / 1e9).toFixed(2) + " GB";

export const COMPACT_USAGE = `Usage: project-brain compact [--project <id>] [--force]

Reclaim storage held by superseded versions and soft-deleted rows, right now.
Refuses when another process has the table open; --force overrides that.
Routine reclamation is automatic (see \`project-brain maintain --help\`).`;

export interface CompactOptions {
  force?: boolean;
  /** Pids with the table open; null when unknowable. Injectable for tests. */
  holders?: (path: string) => number[] | null;
}

/**
 * Reclaim storage held by superseded versions and soft-deleted rows.
 *
 * It passes `deleteUnverified`, which removes files lance cannot prove are
 * unreferenced, so it refuses while any process has the table open. An
 * unreadable holder check counts as "open": only --force proceeds past it.
 */
export async function compactCommand(
  project: string,
  dbPath: string = DB_PATH,
  options: CompactOptions = {}
): Promise<void> {
  const path = tablePath(dbPath, project);

  const before = await dirSize(path);
  if (before === 0) {
    console.error(`compact: no table found for project "${project}"`);
    process.exitCode = 1;
    return;
  }

  if (!options.force) {
    const holders = (options.holders ?? ((p) => lsofTableHolders(p)))(path);
    if (holders === null || holders.length > 0) {
      const why = holders === null ? "could not check whether it is in use" : `in use by process ${holders.join(", ")}`;
      console.error(`compact: ${project} ${why}; nothing compacted.`);
      console.error("Stop those project-brain processes, or pass --force to compact anyway.");
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Compacting ${project} (${gb(before)})…`);

  const store = new LanceDbStore(dbPath);
  try {
    await store.compactAggressively(project, AGGRESSIVE_RETENTION_MS);
  } catch (err) {
    console.error(`compact: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const after = await dirSize(path);
  console.log(`${gb(before)}  ->  ${gb(after)}   (reclaimed ${gb(Math.max(0, before - after))})`);
}
