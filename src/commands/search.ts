import type { EmbeddingClient, VectorStore } from "../types.js";
import { handleSearch } from "../tools/search.js";

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

export interface SearchArgs {
  query: string;
  project: string;
  limit: number;
}

export interface SearchDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
  /** When present, infra-level failures are recorded for `project-brain health`. */
  dbPath?: string;
}

/**
 * Core search logic — DI-friendly for testing.
 * Calls handleSearch with the same pipeline as the MCP tool, then
 * formats results as a compact markdown block for hook injection.
 *
 * Fail-fast contract: any error → print nothing, return (never throws).
 */
export async function runSearch(args: SearchArgs, deps: SearchDeps): Promise<void> {
  const { query, project, limit } = args;

  // Empty query → no-op
  if (!query.trim()) return;

  try {
    const result = await handleSearch({ project, query, limit }, deps);

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

    const results = parsed.results;
    if (!results || results.length === 0) return;

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
  readStdin: () => Promise<string> = () => Bun.stdin.text()
): Promise<void> {
  // Hard self-timeout: race against 4000ms so a hung ollama never blocks a prompt
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, 4000);
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

      if (useStdin) {
        // Read ALL of stdin, parse JSON, use .prompt as query.
        // Any failure (empty, bad JSON, missing .prompt) → no-op.
        try {
          const raw = await readStdin();
          query = parsePromptFromStdin(raw);
        } catch {
          return;
        }
      } else {
        query = queryParts.join(" ");
      }

      if (!query.trim()) return;

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
      });

      // `project` is narrowed to `string` here by the `if (!project) return;`
      // check above (line 177) — no guard needed in this branch, unlike the
      // outer catch below where the throw point (and thus narrowing) is unknown.
      const { clearLastError } = await import("../store/error-state.js");
      await clearLastError(DB_PATH, project, "search-setup");

      await runSearch({ query, project, limit }, { store, embeddings, dbPath: DB_PATH });
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
