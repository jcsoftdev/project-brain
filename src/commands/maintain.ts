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
  3. only with the opt-in Jev assist for MCP pruning (config:mcp-prune-jev or
     PROJECT_BRAIN_MCP_PRUNE_JEV=1) and a TypeSafe token: prunes the MCP servers of
     registered projects (at most 20 Jev requests, 15 s), silently; sessions already
     running keep their servers, the next one starts without the pruned ones

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

/**
 * Step 3: the opt-in MCP prune across registered projects. Between sessions only:
 * SessionEnd runs maintain after the session is gone. Silent and never throws.
 */
export async function maintainMcpPrune(
  opts: import("../mcpprune/auto.js").AutoPruneOptions = { dataDir: DATA_DIR }
): Promise<import("../mcpprune/auto.js").AutoPruneResult | null> {
  try {
    const { autoPrune } = await import("../mcpprune/auto.js");
    return await autoPrune(opts);
  } catch {
    return null; // best-effort; setup and update prune too
  }
}

/** The housekeeping steps, injectable so a test can run the command without touching real indexes. */
export interface MaintainSteps {
  pruneWorktrees: () => Promise<unknown>;
  mcpPrune: () => Promise<unknown>;
  /** Compacts and returns the line to print, if any. */
  compact: () => Promise<string | null>;
  /** Computes the new-setup-units list the prompt hook announces, so no prompt ever inspects a unit. */
  whatsNew?: () => Promise<unknown>;
}

export const defaultMaintainSteps = (): MaintainSteps => ({
  pruneWorktrees: async () => {
    const { pruneWorktrees } = await import("./worktree.js");
    await pruneWorktrees();
  },
  mcpPrune: () => maintainMcpPrune(),
  compact: async () =>
    summarize(await autoCompact(defaultAutoCompactDeps({ dbPath: DB_PATH, dataDir: DATA_DIR, ownProject: await currentProjectKey() }))),
  whatsNew: async () => (await import("./setup.js")).refreshWhatsNew(),
});

/** Never throws and never exits non-zero: it runs inside a host's hook. */
export async function maintainCommand(args: string[], steps: MaintainSteps = defaultMaintainSteps()): Promise<void> {
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
    await steps.pruneWorktrees();
  } catch {
    // dead-worktree reclamation is best-effort; compaction is independent of it
  }

  await steps.mcpPrune().catch(() => {});
  await steps.whatsNew?.().catch(() => {});

  const line = await steps.compact();
  if (line) console.log(line);
}
