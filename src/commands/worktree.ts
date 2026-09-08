import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, DB_PATH } from "../constants.js";
import { readRegistry, unregisterProjects } from "../store/project-registry.js";
import {
  parseScopedProjectId,
  isScopedProjectId,
  scopedProjectId,
  deriveProjectId,
} from "../indexer/project-id.js";
import { listLiveWorktrees, detectGitContext } from "../git/worktree.js";

export interface WorktreeStatus {
  /**
   * Repository name as mcp-port-registry spells it: lowercased, from the origin remote.
   * Pass this as `project` to port_acquire — NOT `projectId`, whose casing is
   * project-brain's own and can differ.
   */
  project: string;
  /** Worktree id both tools agree on: directory basename, or "main". */
  worktree: string;
  /** project-brain's scoping key: the base id, suffixed for a linked worktree. */
  projectId: string;
  /** This working tree's own toplevel. */
  root: string;
  isMain: boolean;
  /** Whether `init` has run here. A linked worktree with false has no usable brain. */
  indexed: boolean;
}

/**
 * Everything an orchestrator needs to give one worktree its own brain and its own port.
 *
 * The two identifier systems meet here and nowhere else. `project` + `worktree` is the
 * pair mcp-port-registry leases ports on; `projectId` is what project-brain keys its
 * index on. They are derived from the same git facts but spelled differently — the
 * registry lowercases repository names and project-brain does not — so a caller that
 * reuses one where the other belongs silently splits the orchestration in half.
 */
export async function worktreeStatus(root: string = process.cwd()): Promise<WorktreeStatus> {
  const ctx = detectGitContext(root);
  const configPath = join(ctx.root, ".project-brain", "project.json");

  // A recorded id wins over a derived one: init writes it, and a project whose id was
  // edited by hand must keep answering to the id its tables were created under.
  let recorded: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as { projectId?: unknown };
    if (typeof parsed.projectId === "string" && parsed.projectId.length > 0) {
      recorded = parsed.projectId;
    }
  } catch {
    // not initialized here
  }

  return {
    project: ctx.project,
    worktree: ctx.worktree,
    projectId: recorded ?? scopedProjectId(await deriveProjectId(ctx.root), ctx.worktree),
    root: ctx.root,
    isMain: ctx.isMain,
    indexed: recorded !== null,
  };
}

/** Just enough of the vector store to reclaim a table; keeps this testable without LanceDB. */
export interface ProjectDropper {
  deleteProject?(project: string): Promise<boolean>;
}

export interface WorktreePruneOptions {
  /** Holds projects.json. Defaults to DATA_DIR (~/.project-brain). */
  dataDir?: string;
  /** Holds the LanceDB tables — a SUBDIRECTORY of dataDir, not the same path. */
  dbPath?: string;
  /** Report what would go without deleting anything. */
  dryRun?: boolean;
  /** DI seam: inject a fake store in tests. */
  store?: ProjectDropper;
}

export interface WorktreeIndex {
  /** Scoped id, e.g. `my-repo@agent-a`. */
  projectId: string;
  /** Worktree directory name the id is scoped to. */
  worktree: string;
  /** Root recorded for it in the registry. */
  root: string;
}

export interface WorktreePruneReport {
  reclaimed: WorktreeIndex[];
  kept: WorktreeIndex[];
}

/**
 * A worktree index is dead when git no longer says that worktree exists.
 *
 * git is the authority, not the filesystem: `git worktree remove` deletes the
 * directory, but a crashed run can leave the directory behind untracked, and the
 * index attached to it is just as stale either way.
 */
function isDead(entry: WorktreeIndex): boolean {
  if (!existsSync(entry.root)) return true;
  return !listLiveWorktrees(entry.root).includes(entry.worktree);
}

/**
 * Reclaim the vector tables and registry entries of worktrees that no longer exist.
 *
 * Deliberately has NO grace window, unlike `prune` for whole projects. There, a missing
 * root can mean an unmounted volume and deleting early destroys the only copy. Here the
 * index is disposable by construction — a worktree's chunks are re-derivable by one
 * `sync` — so the cost of reclaiming one early is a re-index, not data loss.
 *
 * Unscoped projects are never candidates, whatever state their roots are in. Those
 * belong to `prune`, which knows about the grace window.
 */
export async function pruneWorktrees(
  options: WorktreePruneOptions = {}
): Promise<WorktreePruneReport> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const registry = await readRegistry(dataDir);

  const reclaimed: WorktreeIndex[] = [];
  const kept: WorktreeIndex[] = [];

  for (const [projectId, entry] of Object.entries(registry)) {
    if (!isScopedProjectId(projectId)) continue;
    const { worktree } = parseScopedProjectId(projectId);
    const index: WorktreeIndex = { projectId, worktree, root: entry.root };
    (isDead(index) ? reclaimed : kept).push(index);
  }

  if (options.dryRun || reclaimed.length === 0) return { reclaimed, kept };

  const store =
    options.store ??
    new (await import("../store/lancedb.js")).LanceDbStore(options.dbPath ?? DB_PATH);

  for (const index of reclaimed) {
    try {
      await store.deleteProject?.(index.projectId);
    } catch {
      // A table that will not drop still gets its registry entry removed: leaving the
      // entry would make the next run report it as reclaimed again, forever.
    }
  }
  await unregisterProjects(
    dataDir,
    reclaimed.map((r) => r.projectId)
  );

  return { reclaimed, kept };
}

/** CLI entry point: `project-brain worktree [status|prune] [--json] [--dry-run]`. */
export async function execute(args: string[]): Promise<void> {
  const sub = args.find((a) => !a.startsWith("--")) ?? "status";

  if (sub === "status") {
    const status = await worktreeStatus();
    if (args.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`root       ${status.root}`);
    console.log(`worktree   ${status.worktree}${status.isMain ? " (main checkout)" : ""}`);
    console.log(`projectId  ${status.projectId}`);
    console.log(`indexed    ${status.indexed ? "yes" : "no"}`);
    console.log("");
    console.log(`port-registry pair: project="${status.project}" worktree="${status.worktree}"`);
    if (!status.indexed) {
      console.log("");
      console.log("Not indexed here. Run `project-brain init` then `project-brain sync`.");
    }
    return;
  }

  if (sub === "prune") {
    const dryRun = args.includes("--dry-run");
    const report = await pruneWorktrees({ dryRun });
    const verb = dryRun ? "Would reclaim" : "Reclaimed";
    if (report.reclaimed.length === 0) {
      console.log("No worktree indexes to reclaim.");
    } else {
      for (const r of report.reclaimed) {
        console.log(`${verb}: ${r.projectId} — worktree gone (${r.root})`);
      }
    }
    for (const k of report.kept) {
      console.log(`Keeping: ${k.projectId} — worktree live (${k.root})`);
    }
    return;
  }

  console.error(`Unknown worktree subcommand: ${sub}`);
  console.error("Usage: project-brain worktree [status|prune] [--json] [--dry-run]");
  process.exitCode = 1;
}
