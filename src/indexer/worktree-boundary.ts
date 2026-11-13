import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Whether `dir` is the root of a linked git worktree: its `.git` is a file
 * whose `gitdir:` points at a directory holding a `commondir` file.
 *
 * A linked worktree nested inside a checkout (`.claude/worktrees/<name>/` is
 * the common case) is a full second copy of the repository on another branch.
 * It has its own index; indexing it into the enclosing checkout duplicates
 * every file under a `.claude/worktrees/<name>/` prefix.
 *
 * `commondir` is what git itself writes into every linked worktree's gitdir to
 * find the shared repository. A submodule also uses a `.git` file, but its
 * gitdir (`.git/modules/<path>`) is a full repository with no `commondir`, so
 * it stays indexed even when its own path ends in `worktrees/<name>`.
 */
export async function isLinkedWorktreeRoot(dir: string): Promise<boolean> {
  try {
    const pointer = await readFile(join(dir, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
    if (!gitdir) return false;
    return (await stat(join(resolve(dir, gitdir), "commondir"))).isFile();
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
