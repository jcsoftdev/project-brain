import type { GraphStore } from "../graph/store.js";
import { handleFindCallers } from "../tools/callgraph.js";
import { collectPositionals } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

/** Core callers logic — DI-friendly (graph already resolved by withGraph). */
export async function runCallers(name: string, graph: GraphStore): Promise<string> {
  const result = await handleFindCallers({ name }, { graph });
  return result.content[0].text;
}

/** CLI entry point for the callers command. */
export async function execute(args: string[]): Promise<void> {
  const [name] = collectPositionals(args, []);
  if (!name) {
    console.error("Usage: project-brain callers <name>");
    process.exit(1);
    return;
  }
  await withGraph((graph) => runCallers(name, graph));
}
