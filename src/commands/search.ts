import type { EmbeddingClient, VectorStore } from "../types.js";
import type { Reranker } from "../rerank/jev.js";
import { featureEnabled } from "../features.js";
import { handleSearch } from "../tools/search.js";
import { isNonCodePrompt } from "./trivial-prompt.js";

/**
 * Hook budget: the UserPromptSubmit race in {@link execute} below gives up
 * after this many ms so a hung Ollama never blocks a prompt. `project-brain
 * health` reuses it to warn when embedding latency alone would blow it.
 */
export const HOOK_TIMEOUT_MS = 4000;

/**
 * Parses the `prompt` field out of a raw JSON string from stdin.
 * Returns the prompt string, or "" for any failure case:
 *   - empty / whitespace-only input
 *   - invalid JSON
 *   - JSON without a string `.prompt` field
 *   - non-object JSON (array, primitive, etc.)
 *
 * Never throws.
 */
export function parsePromptFromStdin(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return "";
    }
    const obj = parsed as Record<string, unknown>;
    return typeof obj.prompt === "string" ? obj.prompt : "";
  } catch {
    return "";
  }
}

/**
 * Hook gating defaults. Reranked scores in practice span ~0.2-0.85, so 0.5 keeps confident hits
 * only. Without a reranker the store scales its best hit to 1.0, so the floor means nothing there
 * and only the cap applies.
 */
export const HOOK_MIN_SCORE = 0.5;
export const HOOK_MAX_HITS = 5;

function envNumber(name: string, fallback: number, valid: (n: number) => boolean): number {
  const n = Number(process.env[name]);
  return process.env[name] && valid(n) ? n : fallback;
}

/** The setup unit switches the whole gate; PROJECT_BRAIN_SEARCH_PROMPT_FILTER=0 turns just the non-code prompt skip off. */
function promptFilterEnabled(gate: boolean): boolean {
  return gate && process.env.PROJECT_BRAIN_SEARCH_PROMPT_FILTER !== "0";
}

export interface SearchArgs {
  query: string;
  /** Precomputed embedding of `query` (hook path), forwarded to handleSearch. */
  queryVector?: number[];
  project: string;
  limit: number;
  /** Drop hits scoring below this (hook path only; the CLI and MCP tool keep every hit). Ignored without a reranker. */
  minScore?: number;
  /** Keep at most this many hits after the score floor. */
  maxHits?: number;
}

export interface SearchDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
  /** When present, infra-level failures are recorded for `project-brain health`. */
  dbPath?: string;
  /** Optional Jev reranker — absent means opt-out (no token configured), never an error. */
  reranker?: Reranker;
}

/**
 * Core search logic — DI-friendly for testing.
 * Calls handleSearch with the same pipeline as the MCP tool, then
 * formats results as a compact markdown block for hook injection.
 *
 * Fail-fast contract: any error → print nothing, return (never throws).
 */
export async function runSearch(args: SearchArgs, deps: SearchDeps): Promise<void> {
  const { query, project, limit, queryVector, minScore = 0, maxHits = Infinity } = args;

  // Empty query → no-op
  if (!query.trim()) return;

  try {
    const result = await handleSearch({ project, query, limit, queryVector }, deps);

    // Embeddings unavailable or retrieval error → print nothing
    if (result.isError) return;

    const parsed = JSON.parse(result.content[0].text) as {
      results?: Array<{
        chunk_id?: string;
        source: string;
        symbol?: string;
        signature?: string;
        snippet: string;
        score: number;
        start_line?: number;
        end_line?: number;
      }>;
    };

    const results = (parsed.results ?? []).filter((r) => r.score >= (deps.reranker ? minScore : 0)).slice(0, maxHits);
    if (results.length === 0) return;

    // Build compact markdown block
    const lines: string[] = ["<project-brain: relevant context for this prompt>"];

    for (const r of results) {
      // Header: source › symbol? (Lstart-end)? [score x.xx]
      const symbol = r.symbol ? ` › ${r.symbol}` : "";
      const range =
        r.start_line != null && r.end_line != null
          ? ` (L${r.start_line}-${r.end_line})`
          : "";
      const score = `[score ${r.score.toFixed(2)}]`;
      lines.push(`- ${r.source}${symbol}${range} ${score}`);

      // Snippet: first two non-empty lines of the pre-budgeted snippet
      const snippet = r.snippet
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(0, 2)
        .map((l) => `  ${l.trim()}`)
        .join("\n");

      if (snippet) lines.push(snippet);
    }

    lines.push("</project-brain>");
    console.log(lines.join("\n"));

    if (deps.dbPath) {
      const { clearLastError } = await import("../store/error-state.js");
      await clearLastError(deps.dbPath, project, "search");
    }
  } catch (err) {
    // Any error (store failure, JSON parse, etc.) → print nothing
    if (deps.dbPath) {
      const { writeLastError } = await import("../store/error-state.js");
      await writeLastError(deps.dbPath, project, "search", err);
    }
    return;
  }
}

/** CLI entry point for the search command. */
export async function execute(
  args: string[],
  /** Optional DI seam for reading stdin — defaults to Bun.stdin.text(). */
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
  /** Optional DI seam replacing the retrieval step (store + embeddings), so tests need neither. */
  retrieve?: (query: string) => Promise<void>
): Promise<void> {
  // Hard self-timeout: race against HOOK_TIMEOUT_MS so a hung ollama never blocks a prompt
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, HOOK_TIMEOUT_MS);
  });

  const workPromise = (async (): Promise<void> => {
    // Declared outside `try` so the outer `catch` below can read it — a
    // `let`/`const` declared inside a `try` block is scoped to that block
    // only and is not visible from its `catch`.
    let project: string | undefined;

    try {
      const useStdin = args.includes("--stdin");

      // Parse args: collect positional words as query, --project <id>, --limit <n>
      let limit = 8;
      const queryParts: string[] = [];

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--stdin") {
          // Handled above — skip
        } else if (args[i] === "--project" && i + 1 < args.length) {
          project = args[++i];
        } else if (args[i] === "--limit" && i + 1 < args.length) {
          const n = parseInt(args[++i], 10);
          if (!isNaN(n) && n > 0) limit = n;
        } else if (!args[i].startsWith("--")) {
          queryParts.push(args[i]);
        }
      }

      let query: string;
      const gate = featureEnabled("search-gate");

      if (useStdin) {
        // Read ALL of stdin, parse JSON, use .prompt as query.
        // Any failure (empty, bad JSON, missing .prompt) → no-op.
        try {
          const raw = await readStdin();
          query = parsePromptFromStdin(raw);
        } catch {
          return;
        }

        // Hook-only gate: an acknowledgement, continuation, slash-command echo or
        // pasted report carries no code question, so skip retrieval entirely.
        // The MCP search_context tool and the CLI `search "<q>"` never take
        // this branch — only stdin, i.e. the UserPromptSubmit hook, does.
        if (promptFilterEnabled(gate) && isNonCodePrompt(query)) return;
      } else {
        query = queryParts.join(" ");
      }

      if (!query.trim()) return;

      const searchPart = async (): Promise<void> => {
        // Resolve projectId from cwd config if not supplied
        if (!project) {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const configPath = join(process.cwd(), ".project-brain", "project.json");
          try {
            const raw = await readFile(configPath, "utf-8");
            const config = JSON.parse(raw) as { projectId?: string };
            project = config.projectId;
          } catch {
            // No config → use cwd basename as fallback
            const { basename } = await import("node:path");
            project = basename(process.cwd());
          }
        }

        if (!project) return;

        const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
        const { LanceDbStore } = await import("../store/lancedb.js");
        const { createEmbeddingClient } = await import("../embeddings/factory.js");
        const { readTableMeta } = await import("../store/meta.js");
        const { createReranker } = await import("../rerank/factory.js");

        const store = new LanceDbStore(DB_PATH);
        // Read the project's actual indexed model — the registry default
        // (dim 1024) is only correct for projects that happen to use it.
        // A stale/wrong dim here defeats handleSearch's null-check-triggered
        // lexical-floor degradation entirely (a wrong-dim vector is not
        // null, so it proceeds to a doomed vector search instead).
        const storedMeta = await readTableMeta(DB_PATH, project);
        const embeddings = await createEmbeddingClient(storedMeta?.model, {
          host: OLLAMA_HOST,
          autoPull: false, // Never download models in hook path
          // The meta we just read carries the width too, and passing it skips
          // both discovery round-trips. That matters here specifically: this
          // command IS the UserPromptSubmit hook, a fresh process per prompt,
          // so an availability probe and a dim-detection embed were being paid
          // from cold before every single search. Measured warm on a developer
          // machine, they were 85ms against 92ms of actual query embedding —
          // 48% of the invocation spent rediscovering recorded facts.
          // Undefined when the project has no meta, which correctly falls
          // through to full discovery.
          recordedDim: storedMeta?.dim,
        });

        // `project` is narrowed to `string` here by the `if (!project) return;`
        // check above (line 177) — no guard needed in this branch, unlike the
        // outer catch below where the throw point (and thus narrowing) is unknown.
        const { clearLastError } = await import("../store/error-state.js");
        await clearLastError(DB_PATH, project, "search-setup");

        // Resolving a token is a cheap env/file read (no network); the reranker's
        // own POST, if any, is bounded by RERANK_TIMEOUT_MS well inside the
        // HOOK_TIMEOUT_MS race this whole execute() runs under.
        const reranker = (await createReranker()) ?? undefined;

        const minScore = envNumber("PROJECT_BRAIN_SEARCH_MIN_SCORE", HOOK_MIN_SCORE, (n) => n >= 0 && n <= 1);
        const maxHits = envNumber("PROJECT_BRAIN_SEARCH_MAX_HITS", HOOK_MAX_HITS, (n) => Number.isInteger(n) && n > 0);
        const hookGate = useStdin && gate ? { minScore, maxHits } : {};

        await runSearch({ query, project, limit, ...hookGate }, { store, embeddings, dbPath: DB_PATH, reranker });
      };

      // Skill/tool suggestions are not made here: `project-brain suggest --stdin` owns them,
      // as a global hook that also reaches projects without an index.
      await (retrieve ? retrieve(query) : searchPart());
    } catch (err) {
      // Any setup error → print nothing
      if (project) {
        const { DB_PATH } = await import("../constants.js");
        const { writeLastError } = await import("../store/error-state.js");
        await writeLastError(DB_PATH, project, "search-setup", err);
      }
    }
  })();

  await Promise.race([workPromise, timeoutPromise]);
}
