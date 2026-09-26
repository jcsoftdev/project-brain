import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EMBEDDING_MODEL, VERSION } from "../constants.js";
import type { EmbeddingClient, VectorStore } from "../types.js";
import { readLastError, type LastError } from "../store/error-state.js";
import { HOOK_TIMEOUT_MS } from "./search.js";

/** Whether <root>/CLAUDE.md's project-brain block matches the current template; "missing" when there is no `.project-brain/project.json` to compare it against. */
export type ProjectRulesState = "current" | "stale" | "missing";

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
  /**
   * Whether a reranker token resolved (env or file) — resolved by the caller,
   * no network call. Defaults to "off" when omitted.
   */
  reranker?: "off" | "configured";
  /**
   * Staleness of the project CLAUDE.md block, resolved by the caller via
   * {@link readProjectRulesState} — same pattern as `manifestChunks`: `health`
   * itself performs no filesystem scanning, the caller already has `root`.
   */
  projectRules?: ProjectRulesState;
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
  /** Wall-clock time of one real embed of a short query, in ms. Undefined when the embed call itself threw. */
  embedLatencyMs?: number;
  /**
   * True when embedLatencyMs alone would exceed the hook's race budget
   * ({@link HOOK_TIMEOUT_MS}) — `isAvailable()` can say "available" from a
   * cheap probe while the real embed is this slow, and the prompt hook then
   * injects nothing every time, silently.
   */
  slowEmbeddings: boolean;
  /** "configured" when a reranker token resolves (env or file); "off" otherwise. */
  reranker: "off" | "configured";
  /** Omitted when the caller did not resolve it (no root available). */
  projectRules?: ProjectRulesState;
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
  const { projectId, store, embeddings, dbPath, manifestChunks } = options;

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
    ...(options.projectRules !== undefined ? { projectRules: options.projectRules } : {}),
  };
}

/**
 * Resolve {@link ProjectRulesState} for `root` from its own persisted config —
 * `.project-brain/project.json` already has `projectId` and `stack`, so this
 * needs no re-detection of either. Module and OKF-bundle presence are cheap,
 * read-only checks of the same kind `init` already performs on every run.
 */
export async function readProjectRulesState(root: string): Promise<ProjectRulesState> {
  let config: { projectId?: string; stack?: unknown };
  try {
    const raw = await readFile(join(root, ".project-brain", "project.json"), "utf-8");
    config = JSON.parse(raw);
  } catch {
    return "missing";
  }
  if (!config.projectId || !config.stack) return "missing";

  const { detectModules } = await import("../indexer/modules.js");
  const { DEFAULT_BUNDLE_DIRNAME } = await import("../okf/init.js");
  const { isProjectRulesCurrent } = await import("../rules/project.js");

  const [modules, hasOkfBundle] = await Promise.all([
    detectModules(root),
    Promise.resolve(existsSync(join(root, DEFAULT_BUNDLE_DIRNAME))),
  ]);

  const current = await isProjectRulesCurrent(root, {
    projectId: config.projectId,
    stack: config.stack as import("../indexer/stack.js").StackInfo,
    modules,
    hasOkfBundle,
  });
  return current ? "current" : "stale";
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
  const { resolveRerankerToken } = await import("../rerank/token.js");
  const storedMeta = await readTableMeta(DB_PATH, projectId);
  const embeddings = await createEmbeddingClient(
    resolveSyncModel({ envModel: process.env.BRAIN_EMBED_MODEL || undefined, storedMeta }),
    { host: OLLAMA_HOST, autoPull: false }
  );
  // Env/file read only — never a network call, per the health contract.
  const reranker = (await resolveRerankerToken()) ? "configured" : "off";

  const result = await runHealth({
    projectId,
    store,
    embeddings,
    dbPath: DB_PATH,
    manifestChunks: await readManifestChunks(root),
    reranker,
    projectRules: await readProjectRulesState(root),
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
  console.log(`  Reranker:   ${result.reranker}`);
  console.log(`  Version:    ${result.version}`);
  if (result.projectRules) console.log(`  Project rules: ${result.projectRules}`);
  if (result.projectRules === "stale") {
    console.log(`  ⚠ CLAUDE.md's project-brain block is stale — run: project-brain init`);
  }
  if (result.lastError) {
    const when = new Date(result.lastError.timestamp).toISOString();
    console.log(`  ⚠ Last error: [${result.lastError.phase}] ${result.lastError.message} (${when})`);
  }
}
