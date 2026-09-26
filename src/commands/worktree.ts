import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
import type { SpawnFn } from "../bench/mine.js";

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
  /**
   * True when the resolved default branch is NOT an ancestor of HEAD — this
   * worktree was created (or has sat) on a base that has since moved on.
   * Absent (not `false`) when the check found nothing to warn about, or when
   * no default branch could be resolved at all — an advisory, never a hard
   * requirement, so an unresolvable case fails silent rather than noisy.
   */
  baseStale?: boolean;
  /** The resolved default branch, e.g. "origin/main", "main", "master". Present only when baseStale is true. */
  defaultBranch?: string;
  /** Short commit where HEAD and defaultBranch last agreed. Present only when baseStale is true. */
  mergeBase?: string;
  /** Commits on defaultBranch that HEAD does not have. Present only when baseStale is true. */
  behindBy?: number;
}

/** git that reports failure as empty string instead of throwing — same seam as bench/mine.ts and okf/candidates.ts. */
function runGit(cwd: string, args: string[], spawn: SpawnFn): string {
  const result = spawn("git", args, { cwd, encoding: "utf-8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/**
 * Resolve the project's default branch: `origin/HEAD`'s symbolic ref first
 * (what a fresh clone actually points at), then a local `main`, then a local
 * `master`. Returns null when none resolves — a repo with no remote and a
 * differently-named trunk (e.g. `trunk`) is not an error, just unresolvable,
 * and this check stays silent about it rather than guessing.
 */
function resolveDefaultBranch(root: string, spawn: SpawnFn): string | null {
  const originHead = runGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], spawn);
  if (originHead) return originHead;

  for (const candidate of ["main", "master"]) {
    const verify = spawn("git", ["rev-parse", "--verify", "--quiet", candidate], { cwd: root, encoding: "utf-8" });
    if (verify.status === 0) return candidate;
  }
  return null;
}

/**
 * Whether `defaultBranch` is an ancestor of HEAD, and if not, where they
 * diverged and by how much. Returns null both when the default branch cannot
 * be resolved AND when it IS an ancestor (nothing to warn about) — the
 * caller only needs to know "is there a warning", not why not.
 */
function checkBaseFreshness(
  root: string,
  spawn: SpawnFn
): { defaultBranch: string; mergeBase: string; behindBy: number } | null {
  const defaultBranch = resolveDefaultBranch(root, spawn);
  if (!defaultBranch) return null;

  const ancestry = spawn("git", ["merge-base", "--is-ancestor", defaultBranch, "HEAD"], { cwd: root, encoding: "utf-8" });
  if (ancestry.status === 0) return null; // up to date
  // Any status other than 1 (the documented "not an ancestor" result) means the
  // check itself is untrustworthy (e.g. an invalid ref) — skip rather than warn.
  if (ancestry.status !== 1) return null;

  const mergeBase = runGit(root, ["merge-base", defaultBranch, "HEAD"], spawn);
  if (!mergeBase) return null;

  const behindBy = Number.parseInt(runGit(root, ["rev-list", "--count", `HEAD..${defaultBranch}`], spawn), 10);
  if (!Number.isFinite(behindBy)) return null;

  return { defaultBranch, mergeBase: mergeBase.slice(0, 7), behindBy };
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
export async function worktreeStatus(
  root: string = process.cwd(),
  spawn: SpawnFn = spawnSync
): Promise<WorktreeStatus> {
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

  const freshness = checkBaseFreshness(ctx.root, spawn);

  return {
    project: ctx.project,
    worktree: ctx.worktree,
    projectId: recorded ?? scopedProjectId(await deriveProjectId(ctx.root), ctx.worktree),
    root: ctx.root,
    isMain: ctx.isMain,
    indexed: recorded !== null,
    ...(freshness ? { baseStale: true as const, ...freshness } : {}),
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
    // T8 — a worktree created on a stale base ran ahead silently; name it.
    if (status.baseStale) {
      console.log("");
      console.log(
        `⚠ ${status.defaultBranch} is ${status.behindBy} commit(s) ahead of this worktree ` +
          `(diverged at ${status.mergeBase}) — consider rebasing or merging.`
      );
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
