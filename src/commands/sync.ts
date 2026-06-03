import { join } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { computeHash } from "../indexer/hash.js";
import { chunkContent } from "../indexer/parser.js";
import { shouldIgnore, loadPatterns } from "../indexer/gitignore.js";
import { WATCHER_ALWAYS_IGNORE } from "../constants.js";
import type { EmbeddingClient, VectorStore, Chunk } from "../types.js";

const CONFIG_DIR = ".project-brain";
const HASH_MANIFEST = "hashes.json";

export interface SyncOptions {
  /** Absolute path to the project root. */
  root: string;
  /** Project identifier used as store namespace. */
  projectId: string;
  /** Injected store (for DI / testing). */
  store: VectorStore;
  /** Injected embedding client (for DI / testing). */
  embeddings: EmbeddingClient;
  /** Only process files listed here (used by --changed-only flag). */
  changedFiles?: string[];
}

export interface SyncResult {
  /** Files indexed this run. */
  ingested: number;
  /** Files skipped due to unchanged content hash. */
  skipped: number;
  /** Files deleted from the store (source removed from disk). */
  deleted: number;
  /** Total files scanned. */
  scanned: number;
}

/** Load the persisted hash manifest. */
async function loadHashManifest(root: string): Promise<Record<string, string>> {
  const path = join(root, CONFIG_DIR, HASH_MANIFEST);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Persist the hash manifest. */
async function saveHashManifest(root: string, manifest: Record<string, string>): Promise<void> {
  const dir = join(root, CONFIG_DIR);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = join(dir, HASH_MANIFEST);
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

/** Recursively list all files under a directory, skipping ignored ones. */
async function listAllFiles(
  dir: string,
  root: string,
  gitignorePatterns: string[]
): Promise<string[]> {
  const results: string[] = [];

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = fullPath.slice(root.length + 1).replace(/\\/g, "/");

    // Apply always-ignore rules
    const alwaysIgnored = WATCHER_ALWAYS_IGNORE.some(
      (pattern) => relPath.startsWith(pattern) || relPath.includes("/" + pattern.replace(/\/$/, ""))
    );
    if (alwaysIgnored) continue;

    // Apply .gitignore rules
    if (shouldIgnore(relPath, gitignorePatterns)) continue;

    if (entry.isDirectory()) {
      const sub = await listAllFiles(fullPath, root, gitignorePatterns);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Core sync logic — DI-friendly.
 * Scans the project, ingests new/changed files, skips unchanged ones.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { root, projectId, store, embeddings } = options;

  // 1. Load hash manifest and gitignore patterns
  const [hashManifest, gitignorePatterns] = await Promise.all([
    loadHashManifest(root),
    loadPatterns(root),
  ]);

  // 2. Collect files to process
  let filePaths: string[];
  if (options.changedFiles && options.changedFiles.length > 0) {
    // Only process specified files (--changed-only mode)
    filePaths = options.changedFiles.map((f) =>
      f.startsWith("/") ? f : join(root, f)
    );
  } else {
    filePaths = await listAllFiles(root, root, gitignorePatterns);
  }

  // 3. Ensure table exists
  await store.ensureTable(projectId);

  let ingested = 0;
  let skipped = 0;
  const newManifest: Record<string, string> = { ...hashManifest };

  // 4. Process each file
  for (const filePath of filePaths) {
    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      // File might have been deleted between listing and reading
      continue;
    }

    const hash = computeHash(content);
    const relPath = filePath.startsWith(root + "/")
      ? filePath.slice(root.length + 1)
      : filePath;

    // Skip if hash unchanged
    if (hashManifest[relPath] === hash) {
      skipped++;
      continue;
    }

    // Determine module from first path segment
    const parts = relPath.split("/");
    const module = parts.length > 1 ? parts[0] : "root";

    // Chunk and embed
    const rawChunks = chunkContent(content, relPath, module);

    const vectors = await embeddings.embed(rawChunks.map((c) => c.content));
    if (!vectors) {
      // Embeddings unavailable — skip this file silently
      continue;
    }

    // Delete old chunks for this source before reinserting
    await store.deleteBySource(projectId, relPath);

    // Build typed chunks
    const chunks: Chunk[] = rawChunks.map((raw, i) => ({
      id: raw.id,
      vector: vectors[i],
      content: raw.content,
      source: relPath,
      module: raw.module,
      content_hash: raw.content_hash,
      updated_at: raw.updated_at,
    }));

    await store.upsert(projectId, chunks);
    newManifest[relPath] = hash;
    ingested++;
  }

  // 5. Detect deleted files (in manifest but no longer on disk)
  let deleted = 0;
  const currentRels = new Set(
    filePaths.map((f) =>
      f.startsWith(root + "/") ? f.slice(root.length + 1) : f
    )
  );
  for (const relPath of Object.keys(hashManifest)) {
    if (!currentRels.has(relPath)) {
      await store.deleteBySource(projectId, relPath);
      delete newManifest[relPath];
      deleted++;
    }
  }

  // 6. Persist updated manifest
  await saveHashManifest(root, newManifest);

  return {
    ingested,
    skipped,
    deleted,
    scanned: filePaths.length,
  };
}

export interface StalenessOptions {
  /** Absolute path to the project root. */
  root: string;
}

export interface StalenessReport {
  /** Files whose disk hash differs from the manifest (need re-sync). */
  stale: number;
  /** Files whose disk hash matches the manifest (up-to-date). */
  current: number;
  /** Total files found on disk (excluding always-ignored). */
  total: number;
}

/**
 * Check how many files are stale (changed since last sync) without running sync.
 * Compares disk hashes against the persisted hash manifest.
 */
export async function checkStaleness(options: StalenessOptions): Promise<StalenessReport> {
  const { root } = options;

  const [hashManifest, gitignorePatterns] = await Promise.all([
    loadHashManifest(root),
    loadPatterns(root),
  ]);

  const filePaths = await listAllFiles(root, root, gitignorePatterns);

  let stale = 0;
  let current = 0;

  for (const filePath of filePaths) {
    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const relPath = filePath.startsWith(root + "/")
      ? filePath.slice(root.length + 1)
      : filePath;
    const hash = computeHash(content);

    if (hashManifest[relPath] === hash) {
      current++;
    } else {
      stale++;
    }
  }

  return { stale, current, total: filePaths.length };
}

/** CLI entry point for the sync command. */
export async function execute(args: string[]): Promise<void> {
  // Dynamic imports to avoid circular deps and keep CLI lean
  const { LanceDbStore } = await import("../store/lancedb.js");
  const { OllamaEmbeddingClient } = await import("../embeddings/ollama.js");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const changedOnly = args.includes("--changed-only");

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

  console.log(`Syncing project: ${projectId}`);

  const result = await runSync({
    root,
    projectId,
    store,
    embeddings,
    changedFiles: changedOnly ? [] : undefined,
  });

  console.log(`  Scanned:  ${result.scanned} files`);
  console.log(`  Ingested: ${result.ingested} files`);
  console.log(`  Skipped:  ${result.skipped} files (unchanged)`);
  if (result.deleted > 0) {
    console.log(`  Deleted:  ${result.deleted} files (removed from disk)`);
  }
  console.log("\nSync complete.");
}
