import { EMBEDDING_MODEL, VERSION } from "../constants.js";
import type { EmbeddingClient, VectorStore } from "../types.js";
import { readLastError, type LastError } from "../store/error-state.js";

export interface HealthOptions {
  /** Project identifier for chunk count lookup. */
  projectId: string;
  /** Injected store (for DI / testing). */
  store: VectorStore;
  /** Injected embedding client (for DI / testing). */
  embeddings: EmbeddingClient;
  /** Base path to look up per-project last-error state. */
  dbPath: string;
  /** Chunks the repo manifest says were written; omitted when the repo has no manifest. */
  manifestChunks?: number;
}

export interface HealthResult {
  store: "connected" | "error";
  embeddings: "available" | "unavailable";
  model: string;
  chunks: number;
  manifestChunks?: number;
  /** The store holds fewer rows than the manifest recorded: sync would skip files that are not indexed. */
  desynced: boolean;
  version: string;
  lastError?: LastError;
}

/**
 * Core health check logic — DI-friendly.
 * Mirrors the check_health MCP tool but operates as a CLI command.
 */
export async function runHealth(options: HealthOptions): Promise<HealthResult> {
  const { projectId, store, embeddings, dbPath, manifestChunks } = options;

  const [embeddingsAvailable, chunks, lastError] = await Promise.all([
    embeddings.isAvailable(),
    store.countChunks(projectId),
    readLastError(dbPath, projectId),
  ]);

  return {
    store: "connected",
    embeddings: embeddingsAvailable ? "available" : "unavailable",
    model: embeddings.model ?? EMBEDDING_MODEL,
    chunks,
    ...(manifestChunks !== undefined ? { manifestChunks } : {}),
    desynced: manifestChunks !== undefined && chunks < manifestChunks,
    version: VERSION,
    ...(lastError ? { lastError } : {}),
  };
}

/** Read-only: health must not create a manifest in a repo that never had one. */
async function readManifestChunks(root: string): Promise<number | undefined> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const path = join(root, ".project-brain", "manifest.db");
  if (!existsSync(path)) return undefined;
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM manifest_chunks").get() as { n: number }).n;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
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
  const { readTableMeta } = await import("../store/meta.js");
  const { resolveSyncModel } = await import("./sync.js");
  const storedMeta = await readTableMeta(DB_PATH, projectId);
  const embeddings = await createEmbeddingClient(
    resolveSyncModel({ envModel: process.env.BRAIN_EMBED_MODEL || undefined, storedMeta }),
    { host: OLLAMA_HOST, autoPull: false }
  );

  const result = await runHealth({ projectId, store, embeddings, dbPath: DB_PATH, manifestChunks: await readManifestChunks(root) });

  const storeIcon = result.store === "connected" ? "✓" : "✗";
  const embIcon = result.embeddings === "available" ? "✓" : "✗";

  console.log(`project-brain health`);
  console.log(`  ${storeIcon} Store:      ${result.store}`);
  console.log(`  ${embIcon} Embeddings: ${result.embeddings} (${result.model})`);
  console.log(`  Chunks:     ${result.chunks}${result.manifestChunks !== undefined ? ` (manifest: ${result.manifestChunks})` : ""}`);
  if (result.desynced) {
    console.log(`  ⚠ Store is missing chunks the manifest recorded — the next sync re-adds them, or run: project-brain reindex`);
  }
  console.log(`  Version:    ${result.version}`);
  if (result.lastError) {
    const when = new Date(result.lastError.timestamp).toISOString();
    console.log(`  ⚠ Last error: [${result.lastError.phase}] ${result.lastError.message} (${when})`);
  }
}
