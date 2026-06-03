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

/**
 * Server-level instructions injected into MCP clients so AI agents understand
 * when and how to use project-brain vs structural/AST tools.
 */
export const SERVER_INSTRUCTIONS = `project-brain — semantic memory of THIS project's code and docs. Retrieves by MEANING, not by string match.

WHEN TO USE: conceptual, cross-file, or fuzzy questions — "how does X work", "where is the logic that handles Y", "what deals with Z" — ESPECIALLY when you don't know the exact symbol name.

WHEN NOT TO USE (prefer an AST/structural tool or grep): exact symbol definition, who-calls-this, call graph, rename/refactor impact. project-brain and structural tools are COMPLEMENTARY — structural answers "exact symbol X", project-brain answers "the area/concept that does Y".

WORKFLOW (token-efficient): call search_context first → it returns ranked snippets, each with a chunk_id. Read the snippets; for only the ones you actually need, call expand_context(chunk_id) for the full body — do NOT re-read whole files.

Tools by intent:
- search_context — semantic/conceptual lookup; returns snippets + chunk_id. PRIMARY.
- expand_context — full body of a chunk_id from search_context.
- list_modules / get_module — browse the indexed structure by module.
- add_knowledge — persist a note/decision into the brain for future sessions.
- delete_knowledge — remove chunks by source (deleted/renamed files).
- check_health — embedding service + index status; run if results look empty or stale.`;
