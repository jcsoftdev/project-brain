import type { GraphStore } from "../graph/store.js";
import { handleFindCallees } from "../tools/callgraph.js";
import { collectPositionals, parseStringFlag } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

/** Core callees logic — DI-friendly (graph already resolved by withGraph). */
export async function runCallees(name: string, graph: GraphStore): Promise<string> {
  const result = await handleFindCallees({ name }, { graph });
  return result.content[0].text;
}

/** CLI entry point for the callees command. */
export async function execute(args: string[]): Promise<void> {
  const [name] = collectPositionals(args, ["--project"]);
  if (!name) {
    console.error("Usage: project-brain callees <name> [--project ID]");
    process.exit(1);
    return;
  }
  await withGraph((graph) => runCallees(name, graph), { project: parseStringFlag(args, "--project") });
}
