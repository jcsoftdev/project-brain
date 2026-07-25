import type { GraphStore } from "../graph/store.js";
import { handleRepoMap } from "../tools/repo-map.js";
import { parseIntFlag, parseListFlag } from "../cli-args.js";
import { withGraph } from "./graph-runner.js";

const BUDGET_DEFAULT = 1000;
const BUDGET_MIN = 100;
const BUDGET_MAX = 8000;

/** Core map logic — DI-friendly (graph already resolved by withGraph). */
export async function runMap(
  budget: number | undefined,
  focus: string[] | undefined,
  graph: GraphStore
): Promise<string> {
  const result = await handleRepoMap({ token_budget: budget, focus }, { graph });
  const structured = result.structuredContent as {
    map: string;
    files: number;
    symbols: number;
    truncated: boolean;
  };

  const footer = `— ${structured.files} files, ${structured.symbols} symbols`;
  const truncationNote = structured.truncated ? "\n(truncated — increase --budget for more)" : "";

  const body = structured.map ? `${structured.map}\n` : "";
  return `${body}${footer}${truncationNote}`;
}

/** CLI entry point for the map command. */
export async function execute(args: string[]): Promise<void> {
  const budget = parseIntFlag(args, "--budget", {
    def: BUDGET_DEFAULT,
    min: BUDGET_MIN,
    max: BUDGET_MAX,
  });
  const focus = parseListFlag(args, "--focus");
  await withGraph((graph) => runMap(budget, focus, graph));
}
