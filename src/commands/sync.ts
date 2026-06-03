import { join } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { computeHash } from "../indexer/hash.js";
import { chunkContent } from "../indexer/parser.js";
import { shouldIgnore, loadPatterns } from "../indexer/gitignore.js";
import { WATCHER_ALWAYS_IGNORE } from "../constants.js";
import type { EmbeddingClient, VectorStore, Chunk } from "../types.js";

const CONFIG_DIR = ".project-brain";
const HASH_MANIFEST = "hashes.json";

export interface SyncProgress {
  phase: "scanning" | "reading" | "embedding" | "storing";
  current: number;
  total: number;
}

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
  /** Progress callback fired at each phase checkpoint. */
  onProgress?: (p: SyncProgress) => void;
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
  const { root, projectId, store, embeddings, onProgress } = options;

  // 1. Load hash manifest and gitignore patterns
  const [hashManifest, gitignorePatterns] = await Promise.all([
    loadHashManifest(root),
    loadPatterns(root),
  ]);

  // 2. Collect files to process
  onProgress?.({ phase: "scanning", current: 0, total: 0 });
  let filePaths: string[];
  if (options.changedFiles && options.changedFiles.length > 0) {
    filePaths = options.changedFiles.map((f) =>
      f.startsWith("/") ? f : join(root, f)
    );
  } else {
    filePaths = await listAllFiles(root, root, gitignorePatterns);
  }
  onProgress?.({ phase: "scanning", current: filePaths.length, total: filePaths.length });

  // 3. Ensure table exists
  await store.ensureTable(projectId);

  let ingested = 0;
  let skipped = 0;
  const newManifest: Record<string, string> = { ...hashManifest };

  // Wave-based pipeline: read → embed → store N files at a time.
  // optimize() after each wave compacts LanceDB fragments and releases RAM.
  // Target: <1GB peak RAM with reasonable throughput.
  const WAVE_SIZE = 30;         // files per wave — 30 × ~10chunks × ~7KB ≈ 2MB/wave
  const READ_CONCURRENCY = 20;
  const EMBED_BATCH_SIZE = 50;  // chunks per Ollama request
  const STORE_CONCURRENCY = 4;  // parallel LanceDB writes
  const MAX_FILE_BYTES = 512_000; // skip files >512KB (likely binary/generated)

  // Count changed files upfront for progress (scan pass without storing)
  let totalChanged = 0;
  let readDone = 0;

  for (let i = 0; i < filePaths.length; i += WAVE_SIZE) {
    const wave = filePaths.slice(i, i + WAVE_SIZE);

    // Step 1: read + hash in parallel batches
    type FileEntry = { relPath: string; hash: string; rawChunks: ReturnType<typeof chunkContent> };
    const waveChanged: FileEntry[] = [];

    for (let j = 0; j < wave.length; j += READ_CONCURRENCY) {
      const batch = wave.slice(j, j + READ_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          const file = Bun.file(filePath);
          if (file.size > MAX_FILE_BYTES) return null; // skip large/binary files
          let content: string;
          try { content = await file.text(); } catch { return null; }

          const relPath = filePath.startsWith(root + "/")
            ? filePath.slice(root.length + 1) : filePath;
          const hash = computeHash(content);

          if (hashManifest[relPath] === hash) return "skipped" as const;

          const parts = relPath.split("/");
          const module = parts.length > 1 ? parts[0] : "root";
          return { relPath, hash, rawChunks: chunkContent(content, relPath, module) };
        })
      );

      for (const r of results) {
        if (r === null) continue;
        if (r === "skipped") { skipped++; } else { waveChanged.push(r); totalChanged++; }
      }
      readDone += batch.length;
      onProgress?.({ phase: "reading", current: readDone, total: filePaths.length });
    }

    if (waveChanged.length === 0) continue;

    // Step 2: embed all chunks in this wave
    const allTexts = waveChanged.flatMap((e) => e.rawChunks.map((c) => c.content));
    const waveVectors: (number[] | null)[] = new Array(allTexts.length).fill(null);
    let embedOffset = 0;
    for (const entry of waveChanged) embedOffset += entry.rawChunks.length; // just used below

    let globalIdx = 0;
    for (const entry of waveChanged) {
      const start = globalIdx;
      globalIdx += entry.rawChunks.length;
      // embed in chunks of EMBED_BATCH_SIZE
      for (let k = start; k < globalIdx; k += EMBED_BATCH_SIZE) {
        const end = Math.min(k + EMBED_BATCH_SIZE, globalIdx);
        const vecs = await embeddings.embed(allTexts.slice(k, end));
        if (vecs) for (let m = 0; m < vecs.length; m++) waveVectors[k + m] = vecs[m];
      }
      onProgress?.({ phase: "embedding", current: globalIdx, total: allTexts.length });
    }

    // Step 3: store with bounded concurrency
    let fileOffset = 0;
    for (let j = 0; j < waveChanged.length; j += STORE_CONCURRENCY) {
      const storeBatch = waveChanged.slice(j, j + STORE_CONCURRENCY);
      await Promise.all(
        storeBatch.map(async (entry, k) => {
          const base = fileOffset + k > 0
            ? waveChanged.slice(0, j + k).reduce((s, e) => s + e.rawChunks.length, 0)
            : 0;
          const chunks: Chunk[] = entry.rawChunks
            .map((raw, ci) => ({ raw, vec: waveVectors[base + ci] }))
            .filter(({ vec }) => vec !== null)
            .map(({ raw, vec }) => ({
              id: raw.id, vector: vec!, content: raw.content,
              source: entry.relPath, module: raw.module,
              content_hash: raw.content_hash, updated_at: raw.updated_at,
            }));

          if (chunks.length === 0) return;
          await store.deleteBySource(projectId, entry.relPath);
          await store.upsert(projectId, chunks);
          newManifest[entry.relPath] = entry.hash;
          ingested++;
          onProgress?.({ phase: "storing", current: ingested, total: totalChanged });
        })
      );
      fileOffset += storeBatch.length;
    }
    // Compact LanceDB fragments accumulated this wave — releases memory
    await store.optimize(projectId);
    // Wave done — GC can reclaim waveChanged and waveVectors
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

  console.log(`Syncing project: ${projectId}\n`);

  const { makeProgressPrinter } = await import("../indexer/progress.js");
  const { onProgress, clear } = makeProgressPrinter();

  const result = await runSync({
    root,
    projectId,
    store,
    embeddings,
    changedFiles: changedOnly ? [] : undefined,
    onProgress,
  });

  clear();
  console.log(`  Scanned:  ${result.scanned} files`);
  console.log(`  Ingested: ${result.ingested} files`);
  console.log(`  Skipped:  ${result.skipped} files (unchanged)`);
  if (result.deleted > 0) {
    console.log(`  Deleted:  ${result.deleted} files (removed from disk)`);
  }
  console.log("\nSync complete.");
}
