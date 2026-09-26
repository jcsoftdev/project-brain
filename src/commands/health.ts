import { EMBEDDING_MODEL, VERSION } from "../constants.js";
import type { EmbeddingClient, VectorStore } from "../types.js";
import { readLastError, type LastError } from "../store/error-state.js";
import { HOOK_TIMEOUT_MS } from "./search.js";
import { formatLastSyncLine, readSyncStatus, type SyncStatusReport } from "./sync-status.js";

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
  /** The last recorded sync outcome (see sync-status.ts), resolved by the caller. Omitted when none was found. */
  lastSync?: SyncStatusReport;
  /**
   * Whether a reranker token resolved (env or file) — resolved by the caller,
   * no network call. Defaults to "off" when omitted.
   */
  reranker?: "off" | "on";
  /** Where the reranker's token came from — set only when reranker is "on". */
  rerankerTokenSource?: "env" | "file";
  /** File path the token was read from — set only when rerankerTokenSource is "file". */
  rerankerTokenPath?: string;
}

export interface HealthResult {
  store: "connected" | "error";
  embeddings: "available" | "unavailable";
  model: string;
  chunks: number;
  manifestChunks?: number;
  /** The store holds fewer rows than the manifest recorded: sync would skip files that are not indexed. */
  desynced: boolean;
  lastSync?: SyncStatusReport;
  version: string;
  lastError?: LastError;
  /** Wall-clock time of one real embed of a short query, in ms. Undefined when the embed call itself threw. */
  embedLatencyMs?: number;
  /**
   * True when embedLatencyMs alone would exceed the hook's race budget
   * ({@link HOOK_TIMEOUT_MS}) — `isAvailable()` can say "available" from a
   * cheap probe while the real embed is this slow, and the prompt hook then
   * injects nothing every time, silently.
   */
  slowEmbeddings: boolean;
  /** "on" when a reranker token resolves (env or file); "off" otherwise. */
  reranker: "off" | "on";
  /** Where the reranker's token came from — present only when reranker is "on". */
  rerankerTokenSource?: "env" | "file";
  /** File path the token was read from — present only when rerankerTokenSource is "file". */
  rerankerTokenPath?: string;
}

/**
 * Times one real embed of a short query — `isAvailable()` alone can be a
 * cheap probe that says "available" while an overloaded embedding backend
 * takes seconds per call, which is exactly what the hook budget guards
 * against. Returns undefined if the embed call itself throws.
 */
export async function measureEmbedLatency(embeddings: EmbeddingClient): Promise<number | undefined> {
  const start = performance.now();
  try {
    await embeddings.embed(["hello"]);
  } catch {
    return undefined;
  }
  return performance.now() - start;
}

/**
 * Core health check logic — DI-friendly.
 * Mirrors the check_health MCP tool but operates as a CLI command.
 */
export async function runHealth(options: HealthOptions): Promise<HealthResult> {
  const { projectId, store, embeddings, dbPath, manifestChunks, lastSync } = options;

  const [embeddingsAvailable, chunks, lastError, embedLatencyMs] = await Promise.all([
    embeddings.isAvailable(),
    store.countChunks(projectId),
    readLastError(dbPath, projectId),
    measureEmbedLatency(embeddings),
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
    ...(embedLatencyMs !== undefined ? { embedLatencyMs } : {}),
    slowEmbeddings: embedLatencyMs !== undefined && embedLatencyMs > HOOK_TIMEOUT_MS,
    reranker: options.reranker ?? "off",
    ...(options.rerankerTokenSource ? { rerankerTokenSource: options.rerankerTokenSource } : {}),
    ...(options.rerankerTokenPath ? { rerankerTokenPath: options.rerankerTokenPath } : {}),
    ...(lastSync ? { lastSync } : {}),
  };
}

/**
 * Formats the CLI's one-line reranker status — never the token itself, only
 * where it came from, so an agent that finds "off" knows exactly what to run.
 */
export function formatRerankerLine(result: Pick<HealthResult, "reranker" | "rerankerTokenSource" | "rerankerTokenPath">): string {
  if (result.reranker !== "on") {
    return "Reranker: off — set TYPESAFE_API_KEY or run project-brain setup";
  }
  const source = result.rerankerTokenSource === "file" ? result.rerankerTokenPath : "TYPESAFE_API_KEY";
  return `Reranker: on (token from ${source})`;
}

/** Read-only: health must not create a manifest in a repo that never had one. */
export async function readManifestChunks(root: string): Promise<number | undefined> {
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
  const { resolveRerankerTokenWithSource } = await import("../rerank/token.js");
  const storedMeta = await readTableMeta(DB_PATH, projectId);
  const embeddings = await createEmbeddingClient(
    resolveSyncModel({ envModel: process.env.BRAIN_EMBED_MODEL || undefined, storedMeta }),
    { host: OLLAMA_HOST, autoPull: false }
  );
  // Env/file read only — never a network call, per the health contract.
  const resolvedToken = await resolveRerankerTokenWithSource();

  const result = await runHealth({
    projectId,
    store,
    embeddings,
    dbPath: DB_PATH,
    manifestChunks: await readManifestChunks(root),
    lastSync: (await readSyncStatus(root)) ?? undefined,
    reranker: resolvedToken ? "on" : "off",
    rerankerTokenSource: resolvedToken?.source,
    rerankerTokenPath: resolvedToken?.path,
  });

  const storeIcon = result.store === "connected" ? "✓" : "✗";
  const embIcon = result.embeddings === "available" ? "✓" : "✗";

  console.log(`project-brain health`);
  console.log(`  ${storeIcon} Store:      ${result.store}`);
  console.log(`  ${embIcon} Embeddings: ${result.embeddings} (${result.model})`);
  console.log(`  Chunks:     ${result.chunks}${result.manifestChunks !== undefined ? ` (manifest: ${result.manifestChunks})` : ""}`);
  if (result.desynced) {
    console.log(`  ⚠ Store is missing chunks the manifest recorded — the next sync re-adds them, or run: project-brain reindex`);
  }
  if (result.embedLatencyMs !== undefined) {
    console.log(`  Embed latency: ${Math.round(result.embedLatencyMs)}ms`);
  }
  if (result.slowEmbeddings) {
    console.log(
      `  ⚠ Embedding latency (${Math.round(result.embedLatencyMs ?? 0)}ms) exceeds the prompt hook's ${HOOK_TIMEOUT_MS}ms budget — the hook will inject nothing while this persists. Check system load or Ollama.`
    );
  }
  console.log(`  ${formatRerankerLine(result)}`);
  console.log(`  Version:    ${result.version}`);
  if (result.lastSync) {
    console.log(`  Last sync:  ${formatLastSyncLine(result.lastSync)}`);
  }
  if (result.lastError) {
    const when = new Date(result.lastError.timestamp).toISOString();
    console.log(`  ⚠ Last error: [${result.lastError.phase}] ${result.lastError.message} (${when})`);
  }
}
