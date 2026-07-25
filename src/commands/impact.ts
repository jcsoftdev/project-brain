import type { GraphStore } from "../graph/store.js";
import { handleImpact } from "../tools/impact.js";
import { collectPositionals, parseIntFlag } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

const MAX_DEPTH_DEFAULT = 6;
const MAX_DEPTH_MIN = 1;
const MAX_DEPTH_MAX = 20;

/** Core impact logic — DI-friendly (graph already resolved by withGraph). */
export async function runImpact(name: string, maxDepth: number | undefined, graph: GraphStore): Promise<string> {
  const result = await handleImpact({ name, maxDepth }, { graph });
  return result.content[0].text;
}

/** CLI entry point for the impact command. */
export async function execute(args: string[]): Promise<void> {
  const [name] = collectPositionals(args, ["--max-depth"]);
  if (!name) {
    console.error("Usage: project-brain impact <name> [--max-depth N]");
    process.exit(1);
    return;
  }
  const maxDepth = parseIntFlag(args, "--max-depth", {
    def: MAX_DEPTH_DEFAULT,
    min: MAX_DEPTH_MIN,
    max: MAX_DEPTH_MAX,
  });
  await withGraph((graph) => runImpact(name, maxDepth, graph));
}
