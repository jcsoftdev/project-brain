import { join } from "node:path";
import { homedir } from "node:os";
import pkg from "../package.json" with { type: "json" };

/** Package version, sourced from package.json (single source of truth). */
export const VERSION: string = pkg.version;

/** Embedding vector dimensionality (nomic-embed-text). */
export const VECTOR_DIM = 768;

/** Default embedding model name. */
export const EMBEDDING_MODEL = "nomic-embed-text";

/** Anthropic model used to generate commit-time conceptual summaries. */
export const CONCEPT_LLM_MODEL = "claude-haiku-4-5";

/** Max modules conceptualized per commit; the rest are logged as pending. */
export const CONCEPT_MODULE_CAP = 5;

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

/**
 * How many files a sync may hold in memory at once — their content, chunks,
 * reused vectors and freshly embedded vectors are all live together, and are
 * released when the window is stored.
 *
 * This is what keeps peak memory a function of the WINDOW rather than of the
 * repository. It matters because `sync_project` runs a full walk inside the
 * long-lived MCP server: without a bound, one cold index left that process
 * holding the whole repo's high-water mark for the rest of its life.
 *
 * 200 keeps embedding saturated — at even a handful of chunks per file a
 * window yields well over EMBED_BATCH_SIZE x EMBED_CONCURRENCY chunks, so the
 * batching never starves waiting for the next window.
 */
export const SYNC_WINDOW_FILES = Number(process.env.BRAIN_SYNC_WINDOW_FILES) || 200;

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

/**
 * Row-count threshold above which buildIndexes() creates a vector ANN
 * (IVF_PQ) index. Below it, LanceDB's exact brute-force scan is faster than
 * index maintenance; above it, per-query latency grows linearly without one.
 */
export const ANN_INDEX_MIN_ROWS = 20_000;

export const MAX_PARSE_BYTES = 512 * 1024;      // skip files > 512KB (minified/generated)

/** Raw file-size ceiling for ordinary code/text files read during sync (unchanged 512KB behavior). */
export const MAX_TEXT_FILE_BYTES = 512_000;
/**
 * Raw pre-extraction file-size ceiling for PDF/DOCX/XLSX documents. Deliberately
 * more conservative than a naive 20MB — exceljs/mammoth unzip fully into memory.
 */
export const MAX_DOC_FILE_BYTES = 10_000_000;
/**
 * Post-extraction truncation cap (characters) for text pulled out of a doc.
 * A cost guard against a pathological spreadsheet exploding into thousands of
 * chunks — extraction still proceeds (truncated), never rejected outright.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
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
  { name: "repo_map", summary: "token-budgeted overview of the most important symbols in the codebase, ranked by PageRank over the call graph. Use for repo orientation / where to start reading.", annotations: RO },
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
  { when: "repo overview / most important symbols / where to start reading", tool: "repo_map" },
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
 * Model-routing guidance for delegated sub-agents (Claude Code only — the
 * `model` param on the Agent/Task tool has no equivalent in other registrars).
 * Data-driven, same pattern as TOOL_ROUTING, so the markdown table rendered
 * into templates/model-routing.claude.md never drifts from this source.
 */
/**
 * A tier is a claim about the WORK, not about a vendor's current lineup.
 *
 * Naming models directly (haiku/sonnet/opus) made every row wrong on the next
 * release, and wrong six times over once the guidance shipped to six hosts.
 * Tiers survive renames; only DEFAULT_HOST_MODELS has to move.
 */
export type RoutingTier = "fast" | "balanced" | "deep";

/**
 * What each tier means, stated so a reader on a host we have never heard of can
 * still map it onto whatever models they do have.
 */
export const ROUTING_TIERS: ReadonlyArray<{ tier: RoutingTier; meaning: string }> = [
  { tier: "fast", meaning: "retrieval, transcription, mechanical edits — no judgment" },
  { tier: "balanced", meaning: "synthesis, implementation, review against known conventions" },
  { tier: "deep", meaning: "genuine tradeoffs, adversarial verification, unknown root causes" },
];

export const MODEL_ROUTING: ReadonlyArray<{
  task: string;
  tier: RoutingTier;
  why: string;
}> = [
  { task: "Read-only web/MCP/grep lookup", tier: "fast", why: "no synthesis, just fetch" },
  { task: 'Codebase exploration — locate ("where is X")', tier: "fast", why: "no analysis needed" },
  { task: "Mechanical compact/archive/copy", tier: "fast", why: "no analysis, just transcription" },
  { task: "Extract or summarize from one known file", tier: "fast", why: "the hard part — finding it — is already done" },
  { task: 'Codebase exploration — explain ("how does X work")', tier: "balanced", why: "needs synthesis across files" },
  { task: "Write or edit code", tier: "balanced", why: "multi-file logic, implementation" },
  { task: "Review a diff/PR for obvious issues", tier: "balanced", why: "pattern matching against conventions" },
  { task: "Resolve a git conflict", tier: "balanced", why: "needs surrounding context + logic" },
  { task: "Debug a failure with a known cause", tier: "balanced", why: "the diagnosis is done; this is the fix" },
  { task: "Debug a failure whose root cause is unknown", tier: "deep", why: "cheap models pattern-match a plausible cause and stop" },
  { task: "Adversarial / blind verification review", tier: "deep", why: "must genuinely try to refute, not rubber-stamp" },
  { task: "Architecture or design decision", tier: "deep", why: "weighs competing tradeoffs" },
  { task: "Choose between competing approaches", tier: "deep", why: "the answer is a judgment, not a lookup" },
];

/**
 * Bumped whenever the rendered section's CONTENT changes, so `setup` can tell a
 * stale written section from a current one.
 *
 * Without it, `hasSection()` conflated "already there" with "already right":
 * a user who accepted the section once kept that text forever, and every later
 * improvement stopped at their machine.
 */
export const ROUTING_CONTENT_VERSION = 2;

/** Concrete model id per tier for one host. `null` = no verifiable stable name. */
export type HostRoutingModels = Record<RoutingTier, string | null>;

/**
 * Per-host tier→model defaults, keyed by the same tool key `setup` derives from
 * a registrar name.
 *
 * `null` is a deliberate answer, not a gap. opencode ids are provider-scoped
 * (`provider/model-id`) and depend on the user's configured provider; Gemini's
 * and Devin Desktop's lineups move faster than our release cadence. Shipping a
 * guessed model id would hand the agent a config that silently fails — worse
 * than shipping the tier and pointing at the user config.
 */
export const DEFAULT_HOST_MODELS: Record<string, HostRoutingModels> = {
  claude: { fast: "haiku", balanced: "sonnet", deep: "opus" },
  // Codex has one flagship: depth comes from reasoning effort, not a third model.
  codex: { fast: "gpt-5.4-mini", balanced: "gpt-5.4", deep: "gpt-5.4" },
  gemini: { fast: null, balanced: null, deep: null },
  // Cursor exposes a literal "fast" tier; anything deeper is `inherit` or a pinned id.
  cursor: { fast: "fast", balanced: null, deep: null },
  opencode: { fast: null, balanced: null, deep: null },
  windsurf: { fast: null, balanced: null, deep: null },
};

/**
 * Markdown table (header + separator + one row per entry) for MODEL_ROUTING.
 *
 * The Model column appears only when the host has at least one verifiable id —
 * a column of blanks teaches nothing and reads like a bug.
 */
export function renderModelRoutingTable(models?: HostRoutingModels): string {
  const named = models && Object.values(models).some((m) => m !== null);

  const header = named ? "| Task | Tier | Model | Why |" : "| Task | Tier | Why |";
  const separator = named ? "| --- | --- | --- | --- |" : "| --- | --- | --- |";
  const rows = MODEL_ROUTING.map((r) =>
    named
      ? `| ${r.task} | ${r.tier} | ${models![r.tier] ?? "—"} | ${r.why} |`
      : `| ${r.task} | ${r.tier} | ${r.why} |`
  );
  return [header, separator, ...rows].join("\n");
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

PROJECT SCOPE: every tool takes an optional \`project\`. Omit it to query the project this server was started in. The structural tools (find_symbol, find_callers, find_callees, impact, trace_path, repo_map) echo the \`project\` they answered for in their result — check it when you passed an explicit \`project\` elsewhere, so you never mix answers from two repositories. A \`project\` that is unregistered or not yet indexed returns code PROJECT_NOT_FOUND.

Tools by intent:
${renderToolList()}`;

/**
 * How often a stdio server checks that its client is still alive.
 *
 * 30s is a deliberate floor on wasted memory, not a latency target: an orphan
 * lingers at most this long instead of for days. Cheaper than it looks — one
 * signal-0 syscall, on an unref'd timer.
 */
export const ORPHAN_CHECK_MS = Number(process.env.BRAIN_ORPHAN_CHECK_MS) || 30_000;
