import { basename } from "node:path";

/**
 * Derive a project namespace from git remote origin URL.
 * Falls back to the directory basename if no remote is configured.
 */
export async function deriveProjectId(root: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return basename(root);
    }

    const url = (await new Response(proc.stdout).text()).trim();
    return extractRepoName(url);
  } catch {
    return basename(root);
  }
}

/** Extract repository name from a git remote URL. */
function extractRepoName(url: string): string {
  // Remove trailing .git
  let cleaned = url.replace(/\.git$/, "");

  // Handle SSH format: git@github.com:org/repo
  if (cleaned.includes(":") && !cleaned.includes("://")) {
    const afterColon = cleaned.split(":").pop() ?? "";
    const parts = afterColon.split("/");
    return parts[parts.length - 1] || basename(cleaned);
  }

  // Handle HTTPS format: https://github.com/org/repo
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || basename(cleaned);
}

/**
 * Separator between a repository's base id and the worktree it was indexed from.
 *
 * `sanitizeProject` (src/store/lancedb.ts) folds this to "_" when it builds a table
 * name, so the separator is for humans reading `projects.json` and for
 * `parseScopedProjectId`, never for the storage layer.
 */
const WORKTREE_SEP = "@";

/**
 * Namespace a project id by the worktree it belongs to.
 *
 * projectId is already the scoping key for both the vector table and the project
 * registry, so giving a worktree its own id is all it takes to give it its own
 * disposable index — no schema changes anywhere. The main checkout keeps the bare
 * base id, which is what makes this change invisible to every existing install.
 */
export function scopedProjectId(base: string, worktree: string): string {
  if (worktree === "main") return base;
  const suffix = `${WORKTREE_SEP}${worktree}`;
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** Inverse of {@link scopedProjectId}. An unscoped id belongs to the main checkout. */
export function parseScopedProjectId(id: string): { base: string; worktree: string } {
  // lastIndexOf, not indexOf: the separator is legal inside a base id, and the
  // worktree suffix is always the final segment.
  const at = id.lastIndexOf(WORKTREE_SEP);
  if (at <= 0) return { base: id, worktree: "main" };
  return { base: id.slice(0, at), worktree: id.slice(at + 1) };
}

/** True when `id` names a linked worktree rather than a main checkout. */
export function isScopedProjectId(id: string): boolean {
  return parseScopedProjectId(id).worktree !== "main";
}
