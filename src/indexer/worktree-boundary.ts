import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether `dir` is the root of a linked git worktree: its `.git` is a file
 * whose `gitdir:` points into some repository's `worktrees/` directory.
 *
 * A linked worktree nested inside a checkout (`.claude/worktrees/<name>/` is
 * the common case) is a full second copy of the repository on another branch.
 * It has its own index; indexing it into the enclosing checkout duplicates
 * every file under a `.claude/worktrees/<name>/` prefix. Submodules also use a
 * `.git` file, but theirs points into `.git/modules/`, so they stay indexed.
 */
export async function isLinkedWorktreeRoot(dir: string): Promise<boolean> {
  try {
    const pointer = await readFile(join(dir, ".git"), "utf8");
    return /^gitdir:.*[/\\]worktrees[/\\][^/\\]+[/\\]?\s*$/m.test(pointer);
  } catch {
    return false;
  }
}

/**
 * Whether `relPath` lies inside a linked worktree nested below `root`. The root
 * itself is never a boundary: a project indexed from its own worktree is fine.
 * `cache` is shared across one batch so each directory is read at most once.
 */
export async function isInsideNestedWorktree(
  root: string,
  relPath: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const segments = relPath.split("/").slice(0, -1);
  for (let depth = 1; depth <= segments.length; depth++) {
    const dir = segments.slice(0, depth).join("/");
    let isBoundary = cache.get(dir);
    if (isBoundary === undefined) {
      isBoundary = await isLinkedWorktreeRoot(join(root, dir));
      cache.set(dir, isBoundary);
    }
    if (isBoundary) return true;
  }
  return false;
}
