import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SpawnFn } from "../bench/mine.js";
import { cloneDependencies, type DependencyOutcome } from "./worktree-dependencies.js";
import { resolveDefaultBranch, worktreeStatus, type WorktreeStatus } from "./worktree.js";

/** Where worktrees live, relative to the main checkout. */
export const WORKTREES_DIR = join(".claude", "worktrees");

/** A branch with nothing of its own on it is not "finished", it is "not started" — give it time. */
const FRESH_GRACE_MS = 60 * 60 * 1000;

const NEVER_DELETE_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  /** git says the directory is gone; `git worktree prune` owns that, not us. */
  prunable: boolean;
}

/** Everything `assessFinish` decides from. Gathered by {@link gatherFacts}, never computed inside the rule. */
export interface FinishFacts {
  isMain: boolean;
  branch: string | null;
  defaultBranch: string | null;
  locked: boolean;
  prunable: boolean;
  /** null when git could not answer — unknown is never "merged". */
  merged: boolean | null;
  /** Branch tip equals the default branch tip: nothing was ever committed on it. */
  tipIsDefaultTip: boolean;
  ageMs: number | null;
  /** Porcelain lines that count as work. A lone untracked `node_modules` symlink is already filtered out. */
  dirty: string[];
  /** Pids holding the directory as cwd; null when the process table could not be read. */
  holders: number[] | null;
  /** The invoking shell's cwd is this worktree or inside it. */
  cwdInside: boolean;
}

export interface FinishAssessment {
  finished: boolean;
  reasons: string[];
}

/**
 * The single definition of "finished". Every removal path, manual or automatic, asks this
 * and nothing else, so the hook can never remove something `finish` would refuse.
 *
 * Unknown answers (git failed, process table unreadable) count against removal.
 */
export function assessFinish(f: FinishFacts): FinishAssessment {
  const reasons: string[] = [];
  if (f.isMain) reasons.push("this is the main checkout");
  if (f.prunable) reasons.push("git reports the directory missing (run `git worktree prune`)");
  if (f.locked) reasons.push("the worktree is locked");
  if (f.branch === null) reasons.push("HEAD is detached, so there is no branch to judge");
  if (f.defaultBranch === null) reasons.push("the default branch could not be resolved");
  if (f.branch !== null && f.defaultBranch !== null && sameBranch(f.branch, f.defaultBranch)) {
    reasons.push("the worktree is on the default branch");
  } else if (f.branch !== null && f.defaultBranch !== null) {
    if (f.merged === null) reasons.push("could not determine whether the branch is merged");
    else if (!f.merged) reasons.push(`branch ${f.branch} is not merged into ${f.defaultBranch}`);
    else if (f.tipIsDefaultTip && f.ageMs !== null && f.ageMs < FRESH_GRACE_MS) {
      reasons.push("no commits on the branch yet and the worktree is under an hour old");
    }
  }
  if (f.dirty.length > 0) reasons.push(`uncommitted work: ${f.dirty.slice(0, 3).join(", ")}${f.dirty.length > 3 ? ", ..." : ""}`);
  if (f.cwdInside) reasons.push("your shell is inside it; leave the directory first");
  if (f.holders === null) reasons.push("could not tell whether a process is using it");
  else if (f.holders.length > 0) reasons.push(`in use by process ${f.holders.join(", ")}`);
  return { finished: reasons.length === 0, reasons };
}

function sameBranch(branch: string, defaultBranch: string): boolean {
  return branch === defaultBranch.replace(/^origin\//, "");
}

export interface LifecycleDeps {
  spawn: SpawnFn;
  /** The invoker's cwd, resolved. */
  cwd: string;
  /** Pids whose cwd is `path` or inside it, own pid excluded; null when unknowable. */
  holders: (path: string) => number[] | null;
  now: () => number;
  /** Drop the brain registry entry (and table) of the worktree rooted at `path`. */
  dropIndex: (path: string) => Promise<void>;
}

/** `lsof -d cwd` lists every process's cwd in one call; `+D` would walk the whole tree. */
export function lsofHolders(path: string, selfPid: number = process.pid, spawn: SpawnFn = spawnSync): number[] | null {
  const r = spawn("lsof", ["-d", "cwd", "-Fpn"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || typeof r.stdout !== "string" || r.stdout.length === 0) return null;
  const pids: number[] = [];
  let pid = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== selfPid && isInside(line.slice(1), path)) pids.push(pid);
  }
  return [...new Set(pids)];
}

export async function defaultDeps(cwd: string = process.cwd()): Promise<LifecycleDeps> {
  return {
    spawn: spawnSync,
    cwd: realpathSync(cwd),
    holders: (p) => lsofHolders(p),
    now: Date.now,
    dropIndex: async (path) => {
      const { pruneWorktrees } = await import("./worktree.js");
      await pruneWorktrees({ roots: [path] });
    },
  };
}

function isInside(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + sep);
}

function git(deps: LifecycleDeps, cwd: string, args: string[]): { ok: boolean; status: number | null; out: string; err: string } {
  const r = deps.spawn("git", args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i) => {
      const lines = block.split("\n");
      const field = (key: string) => lines.find((l) => l === key || l.startsWith(`${key} `));
      const path = field("worktree")?.slice("worktree ".length) ?? "";
      const branchRef = field("branch")?.slice("branch ".length) ?? null;
      return {
        path,
        branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
        isMain: i === 0,
        locked: field("locked") !== undefined,
        prunable: field("prunable") !== undefined,
      };
    });
}

export function listEntries(deps: LifecycleDeps, from: string = deps.cwd): WorktreeEntry[] {
  const r = git(deps, from, ["worktree", "list", "--porcelain"]);
  return r.ok ? parseWorktreeList(r.out).map((e) => ({ ...e, path: safeRealpath(e.path) })) : [];
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Defaults to compare against: the resolved one, plus its local twin when that is `origin/<x>`. */
function mergeTargets(defaultBranch: string): string[] {
  const local = defaultBranch.replace(/^origin\//, "");
  return local === defaultBranch ? [defaultBranch] : [defaultBranch, local];
}

/** Status lines that are work. A lone untracked `node_modules` symlink is the known leftover of isolation worktrees. */
function dirtyLines(deps: LifecycleDeps, path: string): { dirty: string[]; nodeModulesSymlink: boolean } {
  const r = git(deps, path, ["status", "--porcelain=v1", "-uall", "--ignore-submodules=none"]);
  if (!r.ok) return { dirty: [`git status failed: ${r.err}`], nodeModulesSymlink: false };
  const lines = r.out.split("\n").filter(Boolean);
  const link = join(path, "node_modules");
  const isLink = (() => {
    try {
      return lstatSync(link).isSymbolicLink();
    } catch {
      return false;
    }
  })();
  const tolerated: string[] = isLink ? lines.filter((l) => l === "?? node_modules") : [];
  return { dirty: lines.filter((l) => !tolerated.includes(l)), nodeModulesSymlink: tolerated.length > 0 };
}

export function gatherFacts(
  entry: WorktreeEntry,
  defaultBranch: string | null,
  mainRoot: string,
  deps: LifecycleDeps
): FinishFacts & { nodeModulesSymlink: boolean } {
  let merged: boolean | null = null;
  let tipIsDefaultTip = false;
  if (entry.branch && defaultBranch) {
    const results = mergeTargets(defaultBranch).map((target) => {
      const r = deps.spawn("git", ["merge-base", "--is-ancestor", entry.branch!, target], { cwd: mainRoot, encoding: "utf-8" });
      return r.status;
    });
    if (results.includes(0)) merged = true;
    else if (results.every((s) => s === 1)) merged = false;
    const tip = git(deps, mainRoot, ["rev-parse", entry.branch]).out;
    tipIsDefaultTip = mergeTargets(defaultBranch).some((t) => git(deps, mainRoot, ["rev-parse", t]).out === tip && tip !== "");
  }

  let ageMs: number | null = null;
  try {
    ageMs = deps.now() - statSync(join(entry.path, ".git")).birthtimeMs;
  } catch {
    // unknown age: the grace rule simply does not apply
  }

  const exists = existsSync(entry.path);
  const { dirty, nodeModulesSymlink } = exists ? dirtyLines(deps, entry.path) : { dirty: [], nodeModulesSymlink: false };

  return {
    isMain: entry.isMain,
    branch: entry.branch,
    defaultBranch,
    locked: entry.locked,
    prunable: entry.prunable,
    merged,
    tipIsDefaultTip,
    ageMs,
    dirty,
    holders: exists ? deps.holders(entry.path) : [],
    cwdInside: isInside(deps.cwd, entry.path),
    nodeModulesSymlink,
  };
}

export interface FinishOutcome {
  path: string;
  branch: string | null;
  /** Under `<repo>/.claude/worktrees`. */
  managed: boolean;
  /** Finished, but outside `.claude/worktrees` and not explicitly included, so left alone. */
  heldBack?: boolean;
  finished: boolean;
  reasons: string[];
  removed: boolean;
  branchDeleted: boolean;
  /** Why the branch survived a removed worktree, when it did. */
  branchNote?: string;
  error?: string;
}

/**
 * Judge one worktree and, with `apply`, remove it.
 *
 * Removal order matters: the `node_modules` symlink goes first (git refuses a worktree
 * holding an untracked entry), and is put back if `git worktree remove` then fails.
 * `--force` and `-D` are deliberately absent: git's own refusals are the second line of defence.
 */
export async function finishWorktree(
  entry: WorktreeEntry,
  ctx: { defaultBranch: string | null; mainRoot: string },
  deps: LifecycleDeps,
  apply: boolean
): Promise<FinishOutcome> {
  const facts = gatherFacts(entry, ctx.defaultBranch, ctx.mainRoot, deps);
  const { finished, reasons } = assessFinish(facts);
  const outcome: FinishOutcome = {
    path: entry.path,
    branch: entry.branch,
    managed: isInside(entry.path, join(ctx.mainRoot, WORKTREES_DIR)),
    finished,
    reasons,
    removed: false,
    branchDeleted: false,
  };
  if (!finished || !apply) return outcome;

  const link = join(entry.path, "node_modules");
  let linkTarget: string | null = null;
  if (facts.nodeModulesSymlink) {
    linkTarget = readlinkSync(link);
    unlinkSync(link);
  }

  const removal = git(deps, ctx.mainRoot, ["worktree", "remove", entry.path]);
  if (!removal.ok) {
    if (linkTarget !== null) symlinkSync(linkTarget, link);
    return { ...outcome, error: removal.err || "git worktree remove failed" };
  }
  outcome.removed = true;

  if (entry.branch && !NEVER_DELETE_BRANCHES.has(entry.branch) && !sameBranch(entry.branch, ctx.defaultBranch ?? "")) {
    const del = git(deps, ctx.mainRoot, ["branch", "-d", entry.branch]);
    outcome.branchDeleted = del.ok;
    if (!del.ok) outcome.branchNote = del.err || "git branch -d refused";
  } else if (entry.branch) {
    outcome.branchNote = "protected branch kept";
  }

  try {
    await deps.dropIndex(entry.path);
  } catch {
    // The registry entry is re-derivable; the next `worktree prune` reclaims it.
  }
  return outcome;
}

export interface Resolved {
  mainRoot: string;
  defaultBranch: string | null;
  entries: WorktreeEntry[];
}

export function resolveRepo(deps: LifecycleDeps): Resolved | null {
  const entries = listEntries(deps);
  if (entries.length === 0) return null;
  const mainRoot = entries[0]!.path;
  return { mainRoot, defaultBranch: resolveDefaultBranch(mainRoot, deps.spawn), entries };
}

/** A name, a path, or nothing (meaning the worktree the invoker is standing in). */
export function pickTarget(target: string | undefined, repo: Resolved, deps: LifecycleDeps): WorktreeEntry | string {
  const linked = repo.entries.filter((e) => !e.isMain);
  const candidates: string[] = [];
  if (target === undefined) {
    const innermost = [...repo.entries].sort((x, y) => y.path.length - x.path.length).find((e) => isInside(deps.cwd, e.path));
    return innermost ?? "not inside a git repository";
  }
  if (target.includes("/") || isAbsolute(target)) candidates.push(safeRealpath(resolve(deps.cwd, target)));
  else candidates.push(join(repo.mainRoot, WORKTREES_DIR, target));
  const byPath = repo.entries.find((e) => candidates.includes(e.path));
  if (byPath) return byPath;
  const byName = linked.filter((e) => basename(e.path) === target || e.branch === target);
  if (byName.length === 1) return byName[0]!;
  return byName.length > 1 ? `"${target}" matches several worktrees; pass the path` : `no worktree matches "${target}"`;
}

export async function sweepWorktrees(
  deps: LifecycleDeps,
  options: { apply: boolean; branches: boolean; includeOutside?: boolean }
): Promise<{ worktrees: FinishOutcome[]; branches: { name: string; deleted: boolean; note?: string }[] } | null> {
  const repo = resolveRepo(deps);
  if (!repo) return null;
  const worktrees: FinishOutcome[] = [];
  for (const entry of repo.entries.filter((e) => !e.isMain)) {
    // A worktree outside .claude belongs to the owner or another tool; only an explicit flag lets a sweep remove it.
    const managed = isInside(entry.path, join(repo.mainRoot, WORKTREES_DIR));
    const mayRemove = managed || options.includeOutside === true;
    const outcome = await finishWorktree(entry, repo, deps, options.apply && mayRemove);
    if (!mayRemove && outcome.finished) outcome.heldBack = true;
    worktrees.push(outcome);
  }

  const branches = repo.defaultBranch ? orphanMergedBranches(deps, repo, worktrees) : [];
  const result = branches.map((name) => ({ name, deleted: false, note: undefined as string | undefined }));
  if (options.apply && options.branches) {
    for (const b of result) {
      const del = git(deps, repo.mainRoot, ["branch", "-d", b.name]);
      b.deleted = del.ok;
      if (!del.ok) b.note = del.err;
    }
  }
  return { worktrees, branches: result };
}

/** Merged local branches no worktree has checked out. Re-read after removals so freshly freed branches are not double-listed. */
function orphanMergedBranches(deps: LifecycleDeps, repo: Resolved, outcomes: FinishOutcome[]): string[] {
  const live = listEntries(deps).map((e) => e.branch);
  const removedBranches = new Set(outcomes.filter((o) => o.removed).map((o) => o.branch));
  const r = git(deps, repo.mainRoot, ["branch", "--merged", repo.defaultBranch!, "--format=%(refname:short)"]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .filter(Boolean)
    .filter((b) => !NEVER_DELETE_BRANCHES.has(b) && !sameBranch(b, repo.defaultBranch!) && !live.includes(b) && !removedBranches.has(b));
}

export interface CreateOptions {
  name: string;
  base?: string;
  branch?: string;
  /** Runs the brain init inside the new worktree; injected so tests need no embedder. */
  init: (root: string) => Promise<void>;
}

export interface CreateResult {
  path: string;
  branch: string;
  status: WorktreeStatus;
  dependencies: DependencyOutcome;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function createWorktree(deps: LifecycleDeps, options: CreateOptions): Promise<CreateResult> {
  if (!NAME_PATTERN.test(options.name)) {
    throw new Error(`invalid worktree name "${options.name}" (letters, digits, '.', '_' and '-' only)`);
  }
  const repo = resolveRepo(deps);
  if (!repo) throw new Error("not inside a git repository");

  const path = join(repo.mainRoot, WORKTREES_DIR, options.name);
  const branch = options.branch ?? `worktree/${options.name}`;
  if (existsSync(path)) throw new Error(`${path} already exists`);
  if (!git(deps, repo.mainRoot, ["check-ref-format", "--branch", branch]).ok) throw new Error(`invalid branch name "${branch}"`);
  if (git(deps, repo.mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    throw new Error(`branch ${branch} already exists`);
  }

  excludeLocally(deps, repo.mainRoot, [`${WORKTREES_DIR.split(sep).join("/")}/`, ...INIT_ARTIFACTS]);

  const add = git(deps, repo.mainRoot, ["worktree", "add", path, "-b", branch, ...(options.base ? [options.base] : [])]);
  if (!add.ok) throw new Error(add.err || "git worktree add failed");

  const dependencies = cloneDependencies(repo.mainRoot, path, deps.spawn);
  if (dependencies.cloned) excludeLocally(deps, repo.mainRoot, dependencies.folders.map((folder) => `/${folder}/`));

  await options.init(safeRealpath(path));
  return { path: safeRealpath(path), branch, status: await worktreeStatus(path, deps.spawn), dependencies };
}

/**
 * What `init` writes into a worktree and `finish` must not mistake for the owner's work.
 * Anchored, so they match at a checkout's root only. `.project-brain/` and `CLAUDE.md` are
 * written unconditionally, `docs/modules/` for detected modules, `.claude/settings.json` by the context hook.
 */
export const INIT_ARTIFACTS = ["/.project-brain/", "/CLAUDE.md", "/docs/modules/", "/.claude/settings.json"];

/**
 * Machine-local exclusion (`info/exclude`), never a tracked file: whether a repo ignores
 * these paths is its owner's call. git keeps one `info/exclude` per repository, shared by
 * every worktree, so these anchored patterns also apply to the main checkout's untracked files.
 */
function excludeLocally(deps: LifecycleDeps, mainRoot: string, lines: string[]): void {
  const common = git(deps, mainRoot, ["rev-parse", "--git-common-dir"]).out;
  const excludePath = join(resolve(mainRoot, common), "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const present = new Set(existing.split("\n"));
  const missing = lines.filter((l) => !present.has(l));
  if (missing.length === 0) return;
  appendFileSync(excludePath, `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
