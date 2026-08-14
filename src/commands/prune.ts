import { DATA_DIR, DB_PATH } from "../constants.js";
import { readRegistry } from "../store/project-registry.js";
import { pruneOrphans, ORPHAN_GRACE_MS, type PruneReport } from "../store/prune.js";
import { LanceDbStore } from "../store/lancedb.js";

export interface PruneCommandOptions {
  /** Show what would go without deleting anything. */
  dryRun?: boolean;
  /** Holds projects.json. Defaults to DATA_DIR (~/.project-brain). */
  dataDir?: string;
  /**
   * Holds the LanceDB tables. Defaults to DB_PATH — which is a SUBDIRECTORY of
   * dataDir, not the same path. Conflating the two makes the store find zero
   * tables and prune report a cheerful "nothing to do".
   */
  dbPath?: string;
}

/**
 * Reclaim storage from projects whose roots are gone.
 *
 * Reports everything it finds and deletes only what the registry can account
 * for and that has been missing past the grace window. Tables the registry
 * cannot attribute are listed but never deleted — a project indexed before the
 * registry existed is indistinguishable from an orphan, and at least one such
 * project is live and in daily use.
 */
export async function pruneCommand(
  options: PruneCommandOptions = {}
): Promise<PruneReport> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const store = new LanceDbStore(options.dbPath ?? DB_PATH);

  const report = await pruneOrphans(store, await readRegistry(dataDir), {
    now: Date.now(),
    graceMs: ORPHAN_GRACE_MS,
    dryRun: options.dryRun,
  });

  const verb = options.dryRun ? "Would delete" : "Deleted";
  if (report.deleted.length === 0) {
    console.log("Nothing to prune.");
  } else {
    for (const c of report.deleted) {
      console.log(`${verb}: ${c.project} — root gone (${c.root})`);
    }
  }

  const held = report.skipped.filter((c) => c.reason === "root-missing");
  for (const c of held) {
    const days = c.missingSince
      ? Math.floor((Date.now() - c.missingSince) / 86_400_000)
      : 0;
    console.log(
      `Holding: ${c.project} — root missing ${days}d, inside the ${Math.floor(ORPHAN_GRACE_MS / 86_400_000)}d grace window`
    );
  }

  const unknown = report.skipped.filter((c) => c.reason === "unknown-provenance");
  if (unknown.length > 0) {
    console.log(
      `\nUnattributed tables (kept — no registry entry claims them, which is NOT proof they are unused):`
    );
    for (const c of unknown) console.log(`  ${c.project}`);
    console.log(
      `  Re-run \`project-brain init\` in a project to register it, or drop one deliberately with \`project-brain delete <project>\`.`
    );
  }

  for (const c of report.failed) {
    console.log(`Failed:  ${c.project} — could not delete (in use?)`);
  }

  return report;
}
