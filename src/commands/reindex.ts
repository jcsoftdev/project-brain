import { runSync, resolveSyncModel, syncExitCode } from "./sync.js";
import { ManifestStore } from "../indexer/manifest-store.js";
import type { SyncProgress, SyncResult } from "./sync.js";
import type { EmbeddingClient, VectorStore } from "../types.js";

export interface ReindexOptions {
  /** Absolute path to the project root. */
  root: string;
  /** Project identifier used as store namespace. */
  projectId: string;
  /** Injected store (for DI / testing). */
  store: VectorStore;
  /** Injected embedding client (for DI / testing). */
  embeddings: EmbeddingClient;
  /** Progress callback forwarded to runSync. */
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Result of a reindex run. Identical shape to SyncResult since runReindex
 * delegates entirely to runSync — `skipped` is always 0 for reindex (full
 * re-scan, no skipping).
 */
export type ReindexResult = SyncResult;

/**
 * Core reindex logic — DI-friendly.
 * Clears the manifest store so all files are treated as new,
 * then runs a full sync. This is equivalent to a "cold start" index.
 */
export async function runReindex(options: ReindexOptions): Promise<ReindexResult> {
  const { root, projectId, store, embeddings, onProgress } = options;

  // 1. Clear the manifest store so runSync treats all files as new
  const manifest = new ManifestStore(root);
  try {
    manifest.clear();
  } finally {
    manifest.close();
  }

  // 2. Run a full sync — no files will be skipped (all hashes are cleared)
  const result = await runSync({ root, projectId, store, embeddings, onProgress });

  return result;
}

/** CLI entry point for the reindex command. */
export async function execute(args: string[]): Promise<void> {
  const { LanceDbStore } = await import("../store/lancedb.js");
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

  if (!process.env.BRAIN_EMBED_MODEL) {
    if (args.includes("--no-embed")) {
      process.env.BRAIN_EMBED_MODEL = "none";
    } else {
      const embedModelFlag = args.find((a) => a.startsWith("--embed-model="));
      if (embedModelFlag) {
        process.env.BRAIN_EMBED_MODEL = embedModelFlag.slice("--embed-model=".length);
      }
    }
  }

  const { DB_PATH, OLLAMA_HOST } = await import("../constants.js");
  const { createEmbeddingClient } = await import("../embeddings/factory.js");
  const { readTableMeta } = await import("../store/meta.js");
  const store = new LanceDbStore(DB_PATH);

  // Same precedence as sync.ts execute(): prefer the model the project's
  // index was already built with (stored table meta) over the registry
  // default, unless BRAIN_EMBED_MODEL explicitly overrides it.
  const storedMeta = await readTableMeta(DB_PATH, projectId);

  // Interactive model choice — reindex is a deliberate full rebuild, so a
  // TTY prompt makes sense here too (unlike sync, which runs unattended).
  // Defaults to the CURRENTLY stored model on Enter, not always option 1.
  const { promptEmbedModel, isOllamaAvailable } = await import("../embeddings/model-prompt.js");
  const choice = await promptEmbedModel({
    ollamaAvailable: await isOllamaAvailable(),
    currentModel: storedMeta?.model,
  });
  if (choice) process.env.BRAIN_EMBED_MODEL = choice;

  const embeddings = await createEmbeddingClient(resolveSyncModel({ envModel: process.env.BRAIN_EMBED_MODEL || undefined, storedMeta }), { host: OLLAMA_HOST, autoPull: true });

  console.log(`Re-indexing project: ${projectId} (full scan)\n`);

  const { makeProgressPrinter, formatDuration, formatModelLabel } = await import("../indexer/progress.js");
  const { onProgress, clear } = makeProgressPrinter();

  const startedAt = Date.now();
  const result = await runReindex({ root, projectId, store, embeddings, onProgress });

  clear();

  if (result.error) {
    // Total embed failure: do not report "Reindex complete." as success
    // (mirrors sync.ts's execute()).
    console.error(`\nError: ${result.error}`);
    process.exit(1);
  }

  console.log(`  Scanned:  ${result.scanned} files`);
  console.log(`  Ingested: ${result.ingested} files`);
  console.log(`  Model:    ${formatModelLabel(embeddings.model)}`);
  console.log(`  Duration: ${formatDuration(Date.now() - startedAt)}`);

  if (result.embedFailed > 0) {
    console.warn(`  Warning:  ${result.embedFailed} chunks failed to embed (partial failure — stored what succeeded).`);
    for (const source of result.embedFailedSources) console.warn(`            - ${source}`);
    console.log("\nReindex incomplete.");
    process.exit(syncExitCode(result));
  }

  console.log("\nReindex complete.");
}
