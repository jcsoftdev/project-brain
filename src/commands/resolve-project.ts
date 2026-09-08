import { dirname, join, basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { GRAPH_DB_FILE } from "../constants.js";
import { openGraphDb } from "../graph/db.js";
import { GraphStore } from "../graph/store.js";
import { detectGitContext } from "../git/worktree.js";

const CONFIG_DIR = ".project-brain";
const CONFIG_FILE = "project.json";

/**
 * The toplevel a walk from `start` must not climb out of, or null when there is none.
 *
 * Only a LINKED worktree gets a boundary. `EnterWorktree` nests worktrees inside the
 * main checkout, so without one the walk below leaves the worktree, finds the main
 * checkout's marker, and answers every structural query from main's graph while the
 * caller is on the worktree's branch. That is not a stale answer, it is a wrong one,
 * and nothing in the output says so.
 */
function worktreeBoundary(start: string): string | null {
  try {
    const ctx = detectGitContext(start);
    return ctx.isMain ? null : ctx.root;
  } catch {
    return null; // no git, no boundary — walk as before
  }
}

/** realpathSync that yields the input when the path cannot be resolved. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Walk UPWARD from `start` (via dirname()) looking for a `.project-brain/`
 * directory. Unlike sync.ts/health.ts (which only check cwd), this upward
 * walk lets structural CLI commands work from any subdirectory of a project.
 * Returns the project root, or null if none is found by the filesystem root —
 * or, inside a linked worktree, by that worktree's own toplevel.
 */
export function findProjectRoot(start: string = process.cwd()): string | null {
  // The GLOBAL data dir is `$HOME/.project-brain` — the same name this walk
  // searches for. Without excluding it, every directory under $HOME that has
  // no marker of its own resolved to $HOME as "the project", yielding a bogus
  // project id (basename of the home dir) and a graph.db path that cannot
  // exist. Computed per call so a test or subprocess overriding HOME is seen.
  const globalDataDir = join(homedir(), CONFIG_DIR);

  // git reports a resolved toplevel (/private/var/... on macOS) while `start` may be
  // the symlinked form, so the boundary is compared on resolved paths. The RETURNED
  // path stays in the caller's own form — resolving it would change every existing
  // answer for a symlinked checkout.
  const boundary = worktreeBoundary(start);

  let current = start;
  for (;;) {
    const candidate = join(current, CONFIG_DIR);
    if (candidate !== globalDataDir && existsSync(candidate)) return current;
    if (boundary && resolved(current) === boundary) return null; // worktree top, uninitialized
    const parent = dirname(current);
    if (parent === current) return null; // reached filesystem root
    current = parent;
  }
}

/**
 * Resolve the project id for `root`: reads `.project-brain/project.json`'s
 * `.projectId`, falling back to the root directory's basename when the
 * config is missing, malformed, or lacks a `projectId` field.
 */
export async function resolveProjectId(root: string): Promise<string> {
  const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as { projectId?: string };
    if (typeof config.projectId === "string" && config.projectId.length > 0) {
      return config.projectId;
    }
  } catch {
    // missing / unreadable / malformed config → fall through to basename
  }
  return basename(root);
}

/**
 * Open the structural graph for `root` — GUARDED by existsSync so we never
 * silently create an empty graph.db (openGraphDb uses `{ create: true }`,
 * which would otherwise mask "project never synced" as "synced but empty").
 * Returns null when no graph.db exists yet at this project root.
 */
export function openProjectGraph(root: string): GraphStore | null {
  const graphPath = join(root, CONFIG_DIR, GRAPH_DB_FILE);
  if (!existsSync(graphPath)) return null;
  return new GraphStore(openGraphDb(graphPath));
}
