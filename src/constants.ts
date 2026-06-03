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
