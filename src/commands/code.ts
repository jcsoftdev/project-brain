import type { VectorStore, SearchResult, SearchCodeDeps } from "../types.js";
import { handleSearchCode } from "../tools/search-code.js";
import { collectPositionals, parseIntFlag } from "../cli-args.js";

const LIMIT_DEFAULT = 10;
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

/** Render search_code's raw SearchResult[] as a compact terminal block. */
function renderCodeResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No matches for "${query}".`;

  const lines: string[] = [`project-brain code — "${query}"`];
  for (const r of results) {
    const symbol = r.symbol_name ? ` › ${r.symbol_name}` : "";
    const range = r.start_line != null && r.end_line != null ? ` (L${r.start_line}-${r.end_line})` : "";
    lines.push(`- ${r.source}${symbol}${range} [score ${r.score.toFixed(2)}]`);

    const snippet = r.content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 2)
      .map((l) => `  ${l.trim()}`)
      .join("\n");
    if (snippet) lines.push(snippet);
  }
  lines.push(`— ${results.length} result${results.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}

/**
 * Core code-search logic — DI-friendly. Pure BM25 (search_code's ftsSearch),
 * no embeddings/Ollama involved at all.
 */
export async function runCode(
  query: string,
  limit: number,
  project: string,
  store: VectorStore
): Promise<string> {
  const deps: SearchCodeDeps = { store };
  const result = await handleSearchCode({ project, query, limit }, deps);
  const structured = result.structuredContent as { results: SearchResult[] };
  return renderCodeResults(query, structured.results);
}

export interface RunCodeCommandDeps {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  exit?: (code: number) => void;
}

/**
 * Guards the "run before sync" case: checks indexed chunk count BEFORE ever
 * touching search — never constructs an embeddings/Ollama client (search_code
 * itself never needs one; this guard just fails fast with an actionable hint
 * instead of a confusing empty result).
 */
export async function runCodeCommand(
  query: string,
  limit: number,
  project: string,
  store: VectorStore,
  deps: RunCodeCommandDeps = {}
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const error = deps.error ?? ((msg: string) => console.error(msg));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const chunkCount = await store.countChunks(project);
  if (chunkCount === 0) {
    error(`No indexed content for project '${project}'. Run \`project-brain sync\` first.`);
    exit(1);
    return;
  }

  log(await runCode(query, limit, project, store));
}

/** CLI entry point for the code command. */
export async function execute(args: string[]): Promise<void> {
  const [query] = collectPositionals(args, ["--limit"]);
  if (!query) {
    console.error('Usage: project-brain code "<query>" [--limit N]');
    process.exit(1);
    return;
  }
  const limit = parseIntFlag(args, "--limit", { def: LIMIT_DEFAULT, min: LIMIT_MIN, max: LIMIT_MAX });

  const { DB_PATH } = await import("../constants.js");
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { findProjectRoot, resolveProjectId } = await import("./resolve-project.js");

  const root = findProjectRoot() ?? process.cwd();
  const project = await resolveProjectId(root);
  const store = new LanceDbStore(DB_PATH);

  await runCodeCommand(query, limit, project, store);
}
