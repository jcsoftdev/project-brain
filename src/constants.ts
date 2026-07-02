import { join } from "node:path";
import { homedir } from "node:os";
import pkg from "../package.json" with { type: "json" };

/** Package version, sourced from package.json (single source of truth). */
export const VERSION: string = pkg.version;

/** Embedding vector dimensionality (nomic-embed-text). */
export const VECTOR_DIM = 768;

/** Default embedding model name. */
export const EMBEDDING_MODEL = "nomic-embed-text";

/** Default LanceDB data directory. */
export const DB_PATH = join(homedir(), ".project-brain", "data");

/** Table name suffix appended to project name. */
export const TABLE_SUFFIX = "_chunks";

/** Default Ollama host address. */
export const OLLAMA_HOST = "http://127.0.0.1:11434";

/** Circuit breaker cooldown in milliseconds. */
export const HEALTH_COOLDOWN_MS = 30_000;

/** Watcher debounce delay per file (ms). */
export const WATCHER_DEBOUNCE_MS = 300;

/** Maximum number of paths per wave when splitting large batches (anti-storm). */
export const WATCHER_MAX_BATCH = 200;

/** Section markers for rule injection. */
export const SECTION_MARKER_START = "<!-- project-brain:start -->";
export const SECTION_MARKER_END = "<!-- project-brain:end -->";

/** Paths to ignore in file watcher (always, regardless of .gitignore). */
export const WATCHER_ALWAYS_IGNORE = [
  // universal
  "node_modules/",
  ".git/",
  ".project-brain/",
  "dist/",
  "build/",
  // JS/TS
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".vercel/",
  // JVM / Kotlin / Android
  "target/",
  ".gradle/",
  ".idea/",
  ".kotlin/",
  "generated/",
  "intermediates/",
  "outputs/",
  // Python
  "__pycache__/",
  ".venv/",
  ".mypy_cache/",
  // Rust
  "target/",
  // iOS / Swift
  ".build/",
  "DerivedData/",
  "Pods/",
  // misc
  ".cache/",
  "coverage/",
  ".nyc_output/",
];

/** Default project-brain data directory. */
export const DATA_DIR = join(homedir(), ".project-brain");

/** Minimum score to include a search result. */
export const SCORE_THRESHOLD = 0.2;

/** MMR lambda: 1 = pure relevance, 0 = pure diversity. */
export const MMR_LAMBDA = 0.6;

/** Maximum tokens to fill in search_context adaptive output. */
export const SEARCH_TOKEN_BUDGET = 1200;

/** Max lines per snippet in adaptive output. */
export const SNIPPET_MAX_LINES = 5;

/** When true, fail fast on vector dim mismatches instead of silently degrading. */
export const HARDNESS = process.env.PROJECT_BRAIN_HARDNESS === "1";

/** Filename for the structural graph SQLite database (resolved under the .project-brain data dir). */
export const GRAPH_DB_FILE = "graph.db";

export const MAX_PARSE_BYTES = 512 * 1024;      // skip files > 512KB (minified/generated)
export const MAX_LINE_LENGTH = 5000;            // skip files with pathological lines
export const PARSER_TEARDOWN_EVERY = 500;       // recreate WASM instance every N files to reclaim linear memory
export const WASM_MAX_PAGES = 4096;             // advisory page count; real backstop is input gating (MAX_PARSE_BYTES) + adaptive teardown + optional OS RSS limit on the indexer process

/**
 * SINGLE SOURCE OF TRUTH for the project-brain tool catalog + routing.
 *
 * Both the MCP `SERVER_INSTRUCTIONS` (sent to clients over the protocol) and the
 * per-project CLAUDE.md rules (written by `init`) are rendered from these — so a
 * new tool can never be advertised in one place and forgotten in the others.
 * Keep this list in lockstep with the tools registered in src/server.ts.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDoc {
  name: string;
  summary: string;
  annotations?: ToolAnnotations;
}

const RO = { readOnlyHint: true, openWorldHint: false } as const;

export const TOOL_CATALOG: ToolDoc[] = [
  { name: "search_context", summary: "semantic/conceptual lookup; returns ranked snippets + chunk_id. PRIMARY for fuzzy/cross-file questions.", annotations: RO },
  { name: "search_code", summary: "exact/keyword full-text search (BM25) over indexed code — identifiers, error strings, exact phrases. No embeddings needed. Not regex.", annotations: RO },
  { name: "expand_context", summary: "full body of a chunk_id from search_context (read this instead of re-reading whole files).", annotations: RO },
  { name: "find_symbol", summary: "exact symbol definition(s) by name: path, line range, kind, signature. Use when you know the name.", annotations: RO },
  { name: "find_callers", summary: "every symbol that calls the named symbol (who depends on X).", annotations: RO },
  { name: "find_callees", summary: "every symbol the named symbol calls (what X depends on).", annotations: RO },
  { name: "impact", summary: "blast radius: all symbols transitively affected if the named symbol changes (reverse call graph).", annotations: RO },
  { name: "trace_path", summary: "shortest call path between two symbols (how does A reach B) — ordered caller→callee chain.", annotations: RO },
  { name: "list_modules", summary: "browse the indexed structure by module.", annotations: RO },
  { name: "get_module", summary: "retrieve all chunks for a module.", annotations: RO },
  { name: "add_knowledge", summary: "persist a note/decision into the brain for future sessions.", annotations: { idempotentHint: true, openWorldHint: false } },
  { name: "delete_knowledge", summary: "remove chunks by source (deleted/renamed files).", annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "check_health", summary: "embedding service + index status; run if results look empty or stale.", annotations: RO },
  { name: "list_projects", summary: "list every indexed project with chunk counts and embedding meta.", annotations: RO },
  { name: "delete_project", summary: "delete an entire indexed project's vector index + metadata (never touches its .project-brain/ directory).", annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "manage_adr", summary: "create or list Architecture Decision Records. Append-only: supersede by creating a new ADR with supersedes:<slug>.", annotations: { idempotentHint: true, openWorldHint: false } },
  { name: "get_architecture", summary: "one-call project summary: detected tech stack, indexed modules, chunk count, and symbol count. Use to orient before drilling into search_context or the structural tools.", annotations: RO },
  { name: "sync_project", summary: "re-index changed files now (incremental). Use when results look stale. Streams progress.", annotations: { idempotentHint: true, openWorldHint: false } },
];

/** Look up a tool's annotations from the catalog (single source of truth). */
export function toolAnnotations(name: string): ToolAnnotations | undefined {
  return TOOL_CATALOG.find((t) => t.name === name)?.annotations;
}

/** Routing rules — (trigger, tool) pairs. Keep aligned with TOOL_CATALOG. */
export const TOOL_ROUTING: ReadonlyArray<{ when: string; tool: string }> = [
  { when: '"where is X defined" / exact symbol by name', tool: "find_symbol" },
  { when: '"what calls X" / "who uses X"', tool: "find_callers" },
  { when: '"what does X call / depend on"', tool: "find_callees" },
  { when: '"what breaks if I change X" / blast radius', tool: "impact" },
  { when: "'how does A end up calling B'", tool: "trace_path" },
  { when: '"how does Y work" / a concept you cannot name exactly', tool: "search_context" },
  { when: "an exact string/identifier you can type verbatim", tool: "search_code" },
];

/** Bullet list of every tool — used by SERVER_INSTRUCTIONS ("Tools by intent"). */
export function renderToolList(): string {
  return TOOL_CATALOG.map((t) => `- ${t.name} — ${t.summary}`).join("\n");
}

/** Markdown doc block (tools + routing + workflow) — used in the project CLAUDE.md. */
export function renderToolDocs(): string {
  const tools = TOOL_CATALOG.map((t) => `- \`${t.name}\` — ${t.summary}`).join("\n");
  const routing = TOOL_ROUTING.map((r) => `- ${r.when} → \`${r.tool}\``).join("\n");
  return `### Available Tools

${tools}

### Routing (pick the right tool — do NOT default to search_context for structural questions)

${routing}

### Workflow

Call \`search_context\` first for fuzzy/conceptual questions → it returns ranked snippets with a \`chunk_id\`; call \`expand_context(chunk_id)\` for full bodies instead of re-reading whole files. For exact symbols, callers/callees, and blast radius use the structural tools above — they are faster and more precise than \`search_context\`.`;
}

/**
 * Server-level instructions injected into MCP clients so AI agents understand
 * when and how to use project-brain vs structural/AST tools. Composed from the
 * single TOOL_CATALOG/TOOL_ROUTING source above.
 */
export const SERVER_INSTRUCTIONS = `project-brain — semantic memory of THIS project's code and docs. Retrieves by MEANING, not by string match.

WHEN TO USE: conceptual, cross-file, or fuzzy questions — "how does X work", "where is the logic that handles Y", "what deals with Z" — ESPECIALLY when you don't know the exact symbol name.

WHEN NOT TO USE (prefer an AST/structural tool or grep): exact symbol definition, who-calls-this, call graph, rename/refactor impact. project-brain and structural tools are COMPLEMENTARY — structural answers "exact symbol X", project-brain answers "the area/concept that does Y".

ROUTING (pick the right tool — do NOT default to search_context for structural questions):
${TOOL_ROUTING.map((r) => `- ${r.when} → ${r.tool}`).join("\n")}

WORKFLOW (token-efficient): call search_context first → it returns ranked snippets, each with a chunk_id. Read the snippets; for only the ones you actually need, call expand_context(chunk_id) for the full body — do NOT re-read whole files.

Tools by intent:
${renderToolList()}`;
