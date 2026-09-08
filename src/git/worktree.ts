import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

/**
 * Where a command is running, in git's terms.
 *
 * The field names and the values they carry are NOT free choices: mcp-port-registry
 * keys its per-worktree port leases on exactly this (project, worktree) pair. If the
 * two tools disagree about what a worktree is called, one half of the orchestration
 * leases a port for a worktree the other half never indexed.
 */
export interface GitContext {
  /** Repository name, lowercased. From the origin remote when there is one. */
  project: string;
  /** Directory basename of a linked worktree; "main" for the main checkout. */
  worktree: string;
  /** True for the main checkout, for a submodule, and outside any repository. */
  isMain: boolean;
  /** The toplevel of THIS working tree — the worktree's own, not the main checkout's. */
  root: string;
}

/** git that reports failure as null instead of throwing: absent repo is an answer here. */
function git(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Last path segment of a remote URL, without `.git`, lowercased. */
function repoNameFromRemote(url: string): string {
  const last = url.replace(/[/:]+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "").trim().toLowerCase();
}

/**
 * Classify `cwd` as a main checkout or a linked worktree.
 *
 * Mirrors mcp-port-registry's `detectGitContext` so both tools name the same worktree
 * identically, with one addition: the submodule guard. `git-dir != git-common-dir` is
 * the test for a linked worktree, but it is equally true inside a submodule. Without
 * the guard every submodule would be indexed as a throwaway worktree of its parent and
 * discarded by `worktree prune` while it was still checked out.
 */
export function detectGitContext(cwd: string): GitContext {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) {
    return { project: basename(cwd).toLowerCase(), worktree: "main", isMain: true, root: cwd };
  }

  const gitDir = resolve(cwd, git(["rev-parse", "--git-dir"], cwd) ?? ".git");
  const commonDir = resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd) ?? ".git");
  const inSubmodule = (git(["rev-parse", "--show-superproject-working-tree"], cwd) ?? "") !== "";
  const isMain = gitDir === commonDir || inSubmodule;

  const remote = git(["remote", "get-url", "origin"], cwd);
  // With no remote, name the repository after its directory. For a linked worktree that
  // must be the MAIN checkout's directory (commonDir/..), so siblings share a project.
  // A submodule's commonDir is <super>/.git/modules/<name>, whose parent is "modules" —
  // meaningless — so a submodule falls back to its own toplevel instead.
  const fallbackDir = inSubmodule ? top : resolve(commonDir, "..");
  const project = remote ? repoNameFromRemote(remote) : basename(fallbackDir).toLowerCase();

  // A worktree is a DIRECTORY. That is what `git worktree remove` deletes, and switching
  // branches inside it must not change its identity. The main checkout is always "main",
  // whatever branch it happens to have checked out.
  const worktree = isMain ? "main" : basename(top);

  return { project, worktree, isMain, root: top };
}

/** Ids of every live worktree of the repo at `cwd`: "main" plus each directory basename. */
export function listLiveWorktrees(cwd: string): string[] {
  const out = git(["worktree", "list", "--porcelain"], cwd);
  if (!out) return [];
  const paths = out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  // `git worktree list` always prints the main worktree first.
  return paths.map((p, i) => (i === 0 ? "main" : basename(p)));
}
