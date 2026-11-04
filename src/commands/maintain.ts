import { basename } from "node:path";
import { DATA_DIR, DB_PATH } from "../constants.js";
import { sanitizeProject } from "../store/table-name.js";
import { autoCompact, defaultAutoCompactDeps, summarize } from "./auto-compact.js";

export const MAINTAIN_USAGE = `Usage: project-brain maintain [--quiet] [--background]

Housekeeping that keeps ~/.project-brain from growing without bound:
  1. drops indexes of worktrees git no longer knows
  2. compacts the largest idle indexes (>= 256 MB, at most 2 per run, 60 s budget,
     at most once per 24 h each), skipping any that a process has open
     and the current project's own

Prints one line only when it reclaimed disk. --background returns at once and
does the work in a detached process. Run by the default-on SessionEnd hook.
Tune with BRAIN_AUTO_COMPACT_MIN_MB, _INTERVAL_HOURS, _MAX_TABLES, _BUDGET_SECONDS,
_QUIET_MINUTES, _RETENTION_MINUTES.`;

/** Safety net for a detached run: well past the table budget, short of forever. */
const DETACHED_LIFETIME_MS = 15 * 60 * 1000;

export function backgroundCommand(
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1]
): string[] {
  const viaBun = /^bun(\.exe)?$/.test(basename(execPath)) && script;
  return [...(viaBun ? [execPath, script] : [execPath]), "maintain", "--quiet"];
}

async function currentProjectKey(): Promise<string | null> {
  try {
    const { findProjectRoot, resolveProjectId } = await import("./resolve-project.js");
    const root = findProjectRoot();
    return root ? sanitizeProject(await resolveProjectId(root)) : null;
  } catch {
    return null;
  }
}

/** Never throws and never exits non-zero: it runs inside a host's hook. */
export async function maintainCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(MAINTAIN_USAGE);
    return;
  }

  if (args.includes("--background")) {
    try {
      const child = Bun.spawn(backgroundCommand(), { stdio: ["ignore", "ignore", "ignore"], detached: true });
      child.unref();
    } catch {
      // nothing to do; the next session end tries again
    }
    return;
  }

  const lifetime = setTimeout(() => process.exit(0), DETACHED_LIFETIME_MS);
  lifetime.unref();

  try {
    const { pruneWorktrees } = await import("./worktree.js");
    await pruneWorktrees();
  } catch {
    // dead-worktree reclamation is best-effort; compaction is independent of it
  }

  const result = await autoCompact(
    defaultAutoCompactDeps({ dbPath: DB_PATH, dataDir: DATA_DIR, ownProject: await currentProjectKey() })
  );
  const line = summarize(result);
  if (line) console.log(line);
}
