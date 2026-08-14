import { DB_PATH } from "../constants.js";
import { LanceDbStore } from "../store/lancedb.js";

/** Versions younger than this survive a compaction. Minutes, not days: the
 *  point of running this by hand is to reclaim what routine maintenance
 *  deliberately keeps. */
const AGGRESSIVE_RETENTION_MS = 10 * 60 * 1000;

async function dirSize(path: string): Promise<number> {
  const proc = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim().split(/\s+/)[0] ?? 0) * 1024;
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(2) + " GB";

/**
 * Reclaim storage held by superseded versions and soft-deleted rows.
 *
 * Deliberately a manual command. It passes `deleteUnverified`, which removes
 * files lance cannot prove are unreferenced — safe only when no other process
 * is reading this store, and no lock can establish that. A human running this
 * knowingly is the only guarantee available.
 */
export async function compactCommand(project: string, dbPath: string = DB_PATH): Promise<void> {
  const tablePath = `${dbPath}/${project.toLowerCase().replace(/[^a-z0-9]/g, "_")}_chunks.lance`;

  const before = await dirSize(tablePath);
  if (before === 0) {
    console.error(`compact: no table found for project "${project}"`);
    process.exitCode = 1;
    return;
  }

  console.log(`Compacting ${project} (${gb(before)})…`);
  console.log("Stop other project-brain servers first — this deletes files a");
  console.log("concurrent reader could still be holding open.\n");

  const store = new LanceDbStore(dbPath);
  try {
    await store.compactAggressively(project, AGGRESSIVE_RETENTION_MS);
  } catch (err) {
    console.error(`compact: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const after = await dirSize(tablePath);
  console.log(`${gb(before)}  ->  ${gb(after)}   (reclaimed ${gb(Math.max(0, before - after))})`);
}
