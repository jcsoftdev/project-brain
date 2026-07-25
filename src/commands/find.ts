import type { GraphStore } from "../graph/store.js";
import { handleFindSymbol } from "../tools/find-symbol.js";
import { collectPositionals } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

/** Core find logic — DI-friendly (graph already resolved by withGraph). */
export async function runFind(name: string, graph: GraphStore): Promise<string> {
  const result = await handleFindSymbol({ name }, { graph });
  return result.content[0].text;
}

/** CLI entry point for the find command. */
export async function execute(args: string[]): Promise<void> {
  const [name] = collectPositionals(args, []);
  if (!name) {
    console.error("Usage: project-brain find <name>");
    process.exit(1);
    return;
  }
  await withGraph((graph) => runFind(name, graph));
}
