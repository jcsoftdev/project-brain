import { join } from "node:path";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { computeHash } from "../indexer/hash.js";
import { chunkContent } from "../indexer/parser.js";
import { shouldIgnore, loadPatterns } from "../indexer/gitignore.js";
import { WATCHER_ALWAYS_IGNORE, GRAPH_DB_FILE } from "../constants.js";
import { mapLimit } from "../indexer/concurrency.js";
import type { EmbeddingClient, VectorStore, Chunk } from "../types.js";
import { WasmParser } from "../parser/wasm.js";
import { extract } from "../parser/extract.js";
import { GraphStore } from "../graph/store.js";
import { openGraphDb } from "../graph/db.js";

const CONFIG_DIR = ".project-brain";
const HASH_MANIFEST = "hashes.json";

interface ManifestEntry {
  hash: string;
  mtime: number;
  /** Per-chunk content hashes keyed by chunk id. Absent in old-format manifests. */
  chunks?: Record<string, string>;
}
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
  /**
   * Number of text chunks that failed to embed (null returned by embed client).
   * 0 means all embeds succeeded (or there was nothing to embed).
   */
  embedFailed: number;
  /**
   * Set when ALL embeds failed (total embed failure, nothing stored).
   * Undefined on success or partial failure.
   */
  error?: string;
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

    // Security (S2): skip symlinks explicitly before any other check.
    //
    // On all POSIX platforms (and Bun), Dirent.isFile() / Dirent.isDirectory()
    // describe the *symlink itself*, not the target — so a symlink already
    // falls through both branches below without this guard. We add the
    // explicit check so the safety is intentional, documented, and not an
    // accidental side-effect of the isFile/isDirectory branches.
    //
    // Reason we skip rather than resolving realpath: a symlink whose target
    // lies outside the project root could pull arbitrary files into the index
    // (credentials, system files, other projects). Skipping is always safe;
    // any file that should be indexed is a real file, not a symlink.
    if (entry.isSymbolicLink()) continue;

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

  // Structural graph: one WasmParser + one GraphStore per run.
  // Ephemeral: disposed at end of run to free WASM memory + close SQLite.
  const configDir = join(root, ".project-brain");
  const graphPath = join(configDir, GRAPH_DB_FILE);
  // Ensure .project-brain/ exists before opening SQLite (may not exist in fresh projects).
  await mkdir(configDir, { recursive: true });
  const graphDb = openGraphDb(graphPath);
  const graph = new GraphStore(graphDb);
  // Structural extraction is best-effort: if the WASM parser cannot initialise
  // (e.g. grammar assets missing in an exotic runtime), skip structural work
  // rather than crashing the whole indexer. parseFile is guarded on `parser` below.
  let parser: WasmParser | null = new WasmParser();
  try {
    await parser.init();
  } catch {
    parser = null;
  }

  try {
    const warmedExts = new Set<string>();

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

    // 3. Ensure table exists (pass model+dim so metadata is stored correctly)
    const tableMeta = embeddings.model
      ? { model: embeddings.model, dim: embeddings.dim }
      : undefined;
    await store.ensureTable(projectId, tableMeta);

    let ingested = 0;
    let skipped = 0;
    const newManifest: Manifest = { ...hashManifest };

    // Pipeline: read all files → embed in large batches → store per mini-wave.
    // mtime fast-path: stat() is ~10x cheaper than file.text() + hash.
    // EMBED_BATCH_SIZE=200: fewer HTTP round-trips to Ollama.
    // SAVE_EVERY=10: batchReplace every 10 files → continuous progress.
    const READ_CONCURRENCY = 20;
    const EMBED_BATCH_SIZE = 64;
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

          // Structural graph: parse + extract symbols (gated by same hash-skip above).
          // Skipped entirely when the WASM parser failed to initialise.
          const ext = relPath.slice(relPath.lastIndexOf("."));
          if (parser && !warmedExts.has(ext)) {
            await parser.warm(ext);
            warmedExts.add(ext);
          }
          const pt = parser?.parseFile(ext, content) ?? null;
          if (pt) {
            try {
              const syms = extract(pt.tree, pt.langId, content);
              graph.replaceFile(relPath, pt.langId, hash, mtime, syms);
            } finally {
              pt.tree.delete();
            }
          }

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

    // Phase B: per-chunk hash diff — identify which chunks actually need re-embedding.
    // For each changed file, compare each chunk's content_hash against the stored manifest.
    // Chunks with an unchanged hash reuse the stored vector via store.getChunkById().
    // Chunks with a new/changed hash are collected for batch embedding.
    //
    // Structure: changedChunkInfos[i] = { entryIdx, chunkIdx } maps embed-slot → file+chunk.
    type ChunkInfo = { entryIdx: number; chunkIdx: number };
    const textsToEmbed: string[] = [];
    const changedChunkInfos: ChunkInfo[] = [];

    // reusedVectors[entryIdx][chunkIdx] = stored vector (or null if needs embedding)
    const reusedVectors: Array<Array<number[] | null>> = pendingEntries.map((e) =>
      new Array(e.rawChunks.length).fill(null)
    );

    for (let ei = 0; ei < pendingEntries.length; ei++) {
      const entry = pendingEntries[ei];
      const prevEntry = hashManifest[entry.relPath];
      const prevChunkHashes: Record<string, string> = prevEntry?.chunks ?? {};
      const hasChunkManifest = !!prevEntry?.chunks;

      for (let ci = 0; ci < entry.rawChunks.length; ci++) {
        const raw = entry.rawChunks[ci];
        const prevHash = prevChunkHashes[raw.id];
        const chunkChanged = !hasChunkManifest || prevHash !== raw.content_hash;

        if (!chunkChanged) {
          // Try to reuse the stored vector for this chunk
          const stored = await store.getChunkById(projectId, raw.id);
          if (stored) {
            reusedVectors[ei][ci] = stored.vector;
            continue; // skip embedding this chunk
          }
          // Stored vector not found (e.g., store was wiped) — re-embed as fallback
        }

        // Needs embedding
        changedChunkInfos.push({ entryIdx: ei, chunkIdx: ci });
        textsToEmbed.push(raw.content);
      }
    }

    // Embed only the changed/new chunks in EMBED_BATCH_SIZE batches
    const embeddedVectors: (number[] | null)[] = new Array(textsToEmbed.length).fill(null);
    const EMBED_CONCURRENCY = 3;
    const batches: Array<{ startIdx: number; texts: string[] }> = [];
    for (let i = 0; i < textsToEmbed.length; i += EMBED_BATCH_SIZE) {
      batches.push({ startIdx: i, texts: textsToEmbed.slice(i, i + EMBED_BATCH_SIZE) });
    }
    let embedDone = 0;
    let embedFailed = 0;
    onProgress?.({ phase: "embedding", current: 0, total: textsToEmbed.length });
    await mapLimit(batches, EMBED_CONCURRENCY, async ({ startIdx, texts }) => {
      const vecs = await embeddings.embed(texts);
      if (vecs) {
        for (let j = 0; j < vecs.length; j++) embeddedVectors[startIdx + j] = vecs[j];
        embedDone = Math.min(embedDone + vecs.length, textsToEmbed.length);
        onProgress?.({ phase: "embedding", current: embedDone, total: textsToEmbed.length });
      } else {
        embedFailed += texts.length;
      }
    });

    // Distribute embedded vectors back into reusedVectors
    for (let i = 0; i < changedChunkInfos.length; i++) {
      const { entryIdx, chunkIdx } = changedChunkInfos[i];
      reusedVectors[entryIdx][chunkIdx] = embeddedVectors[i];
    }

    // Phase C: store every SAVE_EVERY files → progress updates, few fragments
    let storeBuf: { sources: string[]; chunks: Chunk[] } = { sources: [], chunks: [] };

    async function flushStore() {
      if (storeBuf.chunks.length === 0) return;
      await store.batchReplace(projectId, storeBuf.sources, storeBuf.chunks);
      storeBuf = { sources: [], chunks: [] };
    }

    for (let ei = 0; ei < pendingEntries.length; ei++) {
      const entry = pendingEntries[ei];
      const entryChunks: Chunk[] = entry.rawChunks
        .map((raw, ci) => ({ raw, vec: reusedVectors[ei][ci] }))
        .filter(({ vec }) => vec !== null)
        .map(({ raw, vec }) => ({
          id: raw.id, vector: vec!, content: raw.content,
          source: entry.relPath, module: raw.module,
          content_hash: raw.content_hash, updated_at: raw.updated_at,
          symbol_name: raw.symbol_name,
          symbol_kind: raw.symbol_kind as import("../types.js").SymbolKind | undefined,
          signature: raw.signature,
          start_line: raw.start_line,
          end_line: raw.end_line,
        }));

      if (entryChunks.length === 0) continue;
      storeBuf.sources.push(entry.relPath);
      storeBuf.chunks.push(...entryChunks);

      // Build per-chunk hash map for the manifest
      const chunkHashes: Record<string, string> = {};
      for (const raw of entry.rawChunks) {
        chunkHashes[raw.id] = raw.content_hash;
      }
      newManifest[entry.relPath] = { hash: entry.hash, mtime: entry.mtime, chunks: chunkHashes };
      ingested++;
      onProgress?.({ phase: "storing", current: ingested, total: totalChanged });

      // Flush every SAVE_EVERY files
      if (storeBuf.sources.length >= SAVE_EVERY) await flushStore();
    }
    await flushStore(); // flush remainder

    // Resolve cross-file call edges for every file that was parsed this run.
    for (const entry of pendingEntries) {
      graph.resolveEdgesForFile(entry.relPath);
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
        graph.deleteFile(relPath);
        delete newManifest[relPath];
        deleted++;
      }
    }

    // 6. Build FTS + vector indexes so hybridSearch works
    await store.buildIndexes(projectId);

    // 7. Persist updated manifest
    await saveHashManifest(root, newManifest);

    // Detect total embed failure: had texts to embed but every vector is null
    const totalEmbedFailure = textsToEmbed.length > 0 && embedFailed === textsToEmbed.length;
    const error = totalEmbedFailure
      ? `Embedding failed: 0/${textsToEmbed.length} vectors produced (Ollama timeout or model unavailable). Nothing was stored.`
      : undefined;

    return {
      ingested,
      skipped,
      deleted,
      scanned: filePaths.length,
      embedFailed,
      error,
    };
  } finally {
    // 8. Dispose structural graph resources (ephemeral — free WASM + close SQLite).
    // Runs even if an error is thrown above to prevent WASM leaks and open WAL handles.
    if (parser) { try { parser.dispose(); } catch {} }
    if (graphDb) { try { graphDb.close(); } catch {} }
  }
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
  const { createEmbeddingClient } = await import("../embeddings/factory.js");
  const store = new LanceDbStore(DB_PATH);
  const embeddings = await createEmbeddingClient(process.env.BRAIN_EMBED_MODEL || undefined, { host: OLLAMA_HOST, autoPull: true });

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

  if (result.error) {
    // Total embed failure: do not report "Ingested: 0" as success
    console.error(`\nError: ${result.error}`);
    process.exit(1);
  }

  console.log(`  Scanned:  ${result.scanned} files`);
  console.log(`  Ingested: ${result.ingested} files`);
  console.log(`  Skipped:  ${result.skipped} files (unchanged)`);
  if (result.deleted > 0) {
    console.log(`  Deleted:  ${result.deleted} files (removed from disk)`);
  }
  if (result.embedFailed > 0) {
    console.warn(`  Warning:  ${result.embedFailed} chunks failed to embed (partial failure — stored what succeeded).`);
  }
  console.log("\nSync complete.");
}
