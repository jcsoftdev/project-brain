import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { runSync } from "./sync.js";
import type { EmbeddingClient, VectorStore } from "../types.js";

const CONFIG_DIR = ".project-brain";
const HASH_MANIFEST = "hashes.json";

export interface ReindexOptions {
  /** Absolute path to the project root. */
  root: string;
  /** Project identifier used as store namespace. */
  projectId: string;
  /** Injected store (for DI / testing). */
  store: VectorStore;
  /** Injected embedding client (for DI / testing). */
  embeddings: EmbeddingClient;
}

export interface ReindexResult {
  /** Files indexed this run. */
  ingested: number;
  /** Always 0 for reindex (full re-scan, no skipping). */
  skipped: number;
  /** Files deleted from the store. */
  deleted: number;
  /** Total files scanned. */
  scanned: number;
}

/**
 * Core reindex logic — DI-friendly.
 * Clears the hash manifest so all files are treated as new,
 * then runs a full sync. This is equivalent to a "cold start" index.
 */
export async function runReindex(options: ReindexOptions): Promise<ReindexResult> {
  const { root, projectId, store, embeddings } = options;

  // 1. Clear the hash manifest so runSync treats all files as new
  const manifestDir = join(root, CONFIG_DIR);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, HASH_MANIFEST), JSON.stringify({}));

  // 2. Run a full sync — no files will be skipped (all hashes are cleared)
  const result = await runSync({ root, projectId, store, embeddings });

  return result;
}

/** CLI entry point for the reindex command. */
export async function execute(args: string[]): Promise<void> {
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { OllamaEmbeddingClient } = await import("../embeddings/ollama.js");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();

  // Load project config
  const configPath = join(root, ".project-brain", "project.json");
  let projectId: string;
  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    projectId = config.projectId;
  } catch {
    console.error(
      "Error: project not initialized. Run `project-brain init` first."
    );
    process.exit(1);
  }

  const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
  const store = new LanceDbStore(DB_PATH);
  const embeddings = new OllamaEmbeddingClient(OLLAMA_HOST);

  console.log(`Re-indexing project: ${projectId} (full scan)`);

  const result = await runReindex({ root, projectId, store, embeddings });

  console.log(`  Scanned:  ${result.scanned} files`);
  console.log(`  Ingested: ${result.ingested} files`);
  console.log("\nReindex complete.");
}
