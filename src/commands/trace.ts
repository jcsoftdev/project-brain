import type { GraphStore } from "../graph/store.js";
import { handleTracePath } from "../tools/trace-path.js";
import { collectPositionals, parseIntFlag } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

const MAX_DEPTH_DEFAULT = 8;
const MAX_DEPTH_MIN = 1;
const MAX_DEPTH_MAX = 20;

/**
 * Core trace logic — DI-friendly (graph already resolved by withGraph).
 * An empty path is NOT an error (unreachable-within-depth is a valid,
 * legitimate answer) — it is rendered as an informational message.
 */
export async function runTrace(
  from: string,
  to: string,
  maxDepth: number | undefined,
  graph: GraphStore
): Promise<string> {
  const result = await handleTracePath({ from, to, maxDepth }, { graph });
  const structured = result.structuredContent as { path: Array<{ path: string; start_line: number; name: string }> };
  const path = structured.path;

  if (path.length === 0) {
    const depth = maxDepth ?? MAX_DEPTH_DEFAULT;
    return `No path found from ${from} to ${to} (within depth ${depth}).`;
  }

  return path.map((hop) => `${hop.path}:${hop.start_line} ${hop.name}()`).join(" → ");
}

/** CLI entry point for the trace command. */
export async function execute(args: string[]): Promise<void> {
  const [from, to] = collectPositionals(args, ["--max-depth"]);
  if (!from || !to) {
    console.error("Usage: project-brain trace <from> <to> [--max-depth N]");
    process.exit(1);
    return;
  }
  const maxDepth = parseIntFlag(args, "--max-depth", {
    def: MAX_DEPTH_DEFAULT,
    min: MAX_DEPTH_MIN,
    max: MAX_DEPTH_MAX,
  });
  await withGraph((graph) => runTrace(from, to, maxDepth, graph));
}
