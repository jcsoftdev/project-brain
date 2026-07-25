import type { GraphStore } from "../graph/store.js";
import { findProjectRoot, openProjectGraph } from "./resolve-project.js";

export interface WithGraphDeps {
  /** DI seam for tests — defaults to findProjectRoot(). */
  findRoot?: () => string | null;
  /** DI seam for tests — defaults to openProjectGraph(root). */
  openGraph?: (root: string) => GraphStore | null;
  /** DI seam for tests — defaults to process.exit. */
  exit?: (code: number) => void;
  /** DI seam for tests — defaults to console.log. */
  log?: (msg: string) => void;
  /** DI seam for tests — defaults to console.error. */
  error?: (msg: string) => void;
}

/**
 * Shared runner for the graph-backed CLI commands (find/callers/callees/
 * impact/trace/map). Resolves the project root, opens the structural graph
 * (guarded — never silently creates one), verifies it isn't empty, then runs
 * `fn` and prints its return value. Exits 1 with an actionable message for
 * every non-executable state; the graph handle is always closed.
 */
export async function withGraph(
  fn: (g: GraphStore) => Promise<string>,
  deps: WithGraphDeps = {}
): Promise<void> {
  const findRoot = deps.findRoot ?? findProjectRoot;
  const openGraph = deps.openGraph ?? openProjectGraph;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const error = deps.error ?? ((msg: string) => console.error(msg));

  const root = findRoot();
  if (!root) {
    error("Not a project-brain project (no .project-brain/ found). Run `project-brain init` first.");
    exit(1);
    return;
  }

  const graph = openGraph(root);
  if (!graph) {
    error("No structural index yet. Run `project-brain sync` first.");
    exit(1);
    return;
  }

  try {
    if (graph.countSymbols() === 0) {
      error("Structural index is empty. Run `project-brain sync` first.");
      exit(1);
      return;
    }
    log(await fn(graph));
  } finally {
    graph.close();
  }
}
