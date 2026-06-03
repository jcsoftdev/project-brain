import { join } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { computeHash } from "../indexer/hash.js";
import { chunkContent } from "../indexer/parser.js";
import { shouldIgnore, loadPatterns } from "../indexer/gitignore.js";
import { WATCHER_ALWAYS_IGNORE } from "../constants.js";
import type { EmbeddingClient, VectorStore, Chunk } from "../types.js";

const CONFIG_DIR = ".project-brain";
const HASH_MANIFEST = "hashes.json";

interface ManifestEntry { hash: string; mtime: number; }
type Manifest = Record<string, ManifestEntry>;

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

/** Load the persisted hash manifest. Supports both legacy (string) and new ({hash,mtime}) format. */
async function loadHashManifest(root: string): Promise<Manifest> {
  const path = join(root, CONFIG_DIR, HASH_MANIFEST);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string | ManifestEntry>;
    const result: Manifest = {};
    for (const [k, v] of Object.entries(parsed)) {
      result[k] = typeof v === "string" ? { hash: v, mtime: 0 } : v;
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist the hash manifest. */
async function saveHashManifest(root: string, manifest: Manifest): Promise<void> {
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
  const newManifest: Manifest = { ...hashManifest };

  // Pipeline: read all files → embed in large batches → store per mini-wave.
  // mtime fast-path: stat() is ~10x cheaper than file.text() + hash.
  // EMBED_BATCH_SIZE=200: fewer HTTP round-trips to Ollama.
  // SAVE_EVERY=10: batchReplace every 10 files → continuous progress.
  const READ_CONCURRENCY = 20;
  const EMBED_BATCH_SIZE = 200;
  const SAVE_EVERY = 10;
  const MAX_FILE_BYTES = 512_000;

  type FileEntry = { relPath: string; hash: string; mtime: number; rawChunks: ReturnType<typeof chunkContent> };

  let totalChanged = 0;
  let readDone = 0;

  // Phase A: stat first (mtime fast-path), read only if mtime changed
  const pendingEntries: FileEntry[] = [];
  const { stat } = await import("node:fs/promises");

  for (let i = 0; i < filePaths.length; i += READ_CONCURRENCY) {
    const batch = filePaths.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        // Fast path: check mtime via stat (no content read)
        let mtime = 0;
        try {
          const s = await stat(filePath);
          if (s.size > MAX_FILE_BYTES) return null;
          mtime = s.mtimeMs;
        } catch { return null; }

        const relPath = filePath.startsWith(root + "/")
          ? filePath.slice(root.length + 1) : filePath;

        const entry = hashManifest[relPath];
        if (entry && entry.mtime === mtime) return "skipped" as const; // mtime unchanged → skip

        // mtime changed → read content + verify hash
        let content: string;
        try { content = await Bun.file(filePath).text(); } catch { return null; }
        const hash = computeHash(content);

        if (entry && entry.hash === hash) {
          // Content identical despite mtime change — update mtime only
          newManifest[relPath] = { hash, mtime };
          return "skipped" as const;
        }

        const parts = relPath.split("/");
        const module = parts.length > 1 ? parts[0] : "root";
        return { relPath, hash, mtime, rawChunks: chunkContent(content, relPath, module) };
      })
    );

    for (const r of results) {
      if (r === null) continue;
      if (r === "skipped") { skipped++; }
      else { pendingEntries.push(r); totalChanged++; }
    }
    readDone += batch.length;
    onProgress?.({ phase: "reading", current: readDone, total: filePaths.length });
  }

  // Phase B+C: embed in large batches, store every SAVE_EVERY files with progress
  // Flatten all texts with back-references
  const allTexts = pendingEntries.flatMap((e) => e.rawChunks.map((c) => c.content));
  const allVectors: (number[] | null)[] = new Array(allTexts.length).fill(null);

  // Embed in EMBED_BATCH_SIZE chunks — show progress per batch
  let embedDone = 0;
  onProgress?.({ phase: "embedding", current: 0, total: allTexts.length });
  for (let i = 0; i < allTexts.length; i += EMBED_BATCH_SIZE) {
    const batch = allTexts.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embeddings.embed(batch);
    if (vecs) for (let j = 0; j < vecs.length; j++) allVectors[i + j] = vecs[j];
    embedDone = Math.min(i + EMBED_BATCH_SIZE, allTexts.length);
    onProgress?.({ phase: "embedding", current: embedDone, total: allTexts.length });
  }

  // Store every SAVE_EVERY files → progress updates, few fragments
  let chunkCursor = 0;
  let storeBuf: { sources: string[]; chunks: Chunk[] } = { sources: [], chunks: [] };

  async function flushStore() {
    if (storeBuf.chunks.length === 0) return;
    await store.batchReplace(projectId, storeBuf.sources, storeBuf.chunks);
    storeBuf = { sources: [], chunks: [] };
  }

  for (let ei = 0; ei < pendingEntries.length; ei++) {
    const entry = pendingEntries[ei];
    const entryChunks: Chunk[] = entry.rawChunks
      .map((raw, ci) => ({ raw, vec: allVectors[chunkCursor + ci] }))
      .filter(({ vec }) => vec !== null)
      .map(({ raw, vec }) => ({
        id: raw.id, vector: vec!, content: raw.content,
        source: entry.relPath, module: raw.module,
        content_hash: raw.content_hash, updated_at: raw.updated_at,
      }));
    chunkCursor += entry.rawChunks.length;

    if (entryChunks.length === 0) continue;
    storeBuf.sources.push(entry.relPath);
    storeBuf.chunks.push(...entryChunks);
    newManifest[entry.relPath] = { hash: entry.hash, mtime: entry.mtime };
    ingested++;
    onProgress?.({ phase: "storing", current: ingested, total: totalChanged });

    // Flush every SAVE_EVERY files
    if (storeBuf.sources.length >= SAVE_EVERY) await flushStore();
  }
  await flushStore(); // flush remainder

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

    const entry = hashManifest[relPath];
    if (entry && entry.hash === hash) {
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
