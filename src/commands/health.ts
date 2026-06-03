import { EMBEDDING_MODEL, VERSION } from "../constants.js";
import type { EmbeddingClient, VectorStore } from "../types.js";

export interface HealthOptions {
  /** Project identifier for chunk count lookup. */
  projectId: string;
  /** Injected store (for DI / testing). */
  store: VectorStore;
  /** Injected embedding client (for DI / testing). */
  embeddings: EmbeddingClient;
}

export interface HealthResult {
  store: "connected" | "error";
  embeddings: "available" | "unavailable";
  model: string;
  chunks: number;
  version: string;
}

/**
 * Core health check logic — DI-friendly.
 * Mirrors the check_health MCP tool but operates as a CLI command.
 */
export async function runHealth(options: HealthOptions): Promise<HealthResult> {
  const { projectId, store, embeddings } = options;

  const [embeddingsAvailable, chunks] = await Promise.all([
    embeddings.isAvailable(),
    store.countChunks(projectId),
  ]);

  return {
    store: "connected",
    embeddings: embeddingsAvailable ? "available" : "unavailable",
    model: EMBEDDING_MODEL,
    chunks,
    version: VERSION,
  };
}

/** CLI entry point for the health command. */
export async function execute(args: string[]): Promise<void> {
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();

  // Load project config to get projectId
  let projectId = "default";
  try {
    const configPath = join(root, ".project-brain", "project.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.projectId) projectId = config.projectId;
  } catch {
    // No config — use default
  }

  const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
  const { createEmbeddingClient } = await import("../embeddings/factory.js");
  const store = new LanceDbStore(DB_PATH);
  const embeddings = await createEmbeddingClient(process.env.BRAIN_EMBED_MODEL || undefined, { host: OLLAMA_HOST, autoPull: false });

  const result = await runHealth({ projectId, store, embeddings });

  const storeIcon = result.store === "connected" ? "✓" : "✗";
  const embIcon = result.embeddings === "available" ? "✓" : "✗";

  console.log(`project-brain health`);
  console.log(`  ${storeIcon} Store:      ${result.store}`);
  console.log(`  ${embIcon} Embeddings: ${result.embeddings} (${result.model})`);
  console.log(`  Chunks:     ${result.chunks}`);
  console.log(`  Version:    ${result.version}`);
}
