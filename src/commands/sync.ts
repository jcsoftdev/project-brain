import { join } from "node:path";
import { readFile, readdir, mkdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { computeHash } from "../indexer/hash.js";
import { chunkContent } from "../indexer/parser.js";
import { shouldIgnore, loadPatterns } from "../indexer/gitignore.js";
import { WATCHER_ALWAYS_IGNORE, GRAPH_DB_FILE } from "../constants.js";
import { mapLimit } from "../indexer/concurrency.js";
import type { EmbeddingClient, VectorStore, Chunk, TableMeta } from "../types.js";
import { WasmParser } from "../parser/wasm.js";
import { extract, extractBoundaries } from "../parser/extract.js";
import { ParserPool, POOL_MIN_FILES } from "../parser/pool.js";
import { GraphStore } from "../graph/store.js";
import { openGraphDb } from "../graph/db.js";
import { ManifestStore } from "../indexer/manifest-store.js";

export interface ManifestEntry {
  hash: string;
  mtime: number;
  /** Per-chunk content hashes keyed by chunk id. Absent in old-format manifests. */
  chunks?: Record<string, string>;
}
export type Manifest = Record<string, ManifestEntry>;

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
  /**
   * Injected structural graph. When provided, runSync USES this shared
   * connection and does NOT open or close one (the caller owns its lifecycle —
   * e.g. the long-lived MCP server). When omitted, runSync opens an ephemeral
   * graph at .project-brain/graph.db and closes it before returning.
   */
  graph?: GraphStore;
}

/** Resolved embedding batch/concurrency configuration for a sync run. */
export interface EmbedConfig {
  batchSize: number;
  concurrency: number;
}

const DEFAULT_EMBED_BATCH_SIZE = 64;
const DEFAULT_EMBED_CONCURRENCY = 3;
const MIN_EMBED_BATCH_SIZE = 1;
const MAX_EMBED_BATCH_SIZE = 512;
const MIN_EMBED_CONCURRENCY = 1;
const MAX_EMBED_CONCURRENCY = 16;

/** Parse a positive-integer env override, clamped to [min, max]. Falls back to `fallback` with a warning on non-numeric/empty/non-integer input. */
function parseEnvInt(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.warn(`[sync] ignoring invalid ${name}=${JSON.stringify(raw)} (must be an integer); using default ${fallback}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve EMBED_BATCH_SIZE / EMBED_CONCURRENCY from env, with defaults
 * unchanged (64 / 3) and sane clamping. Pure/DI-friendly: pass an env map in
 * tests, defaults to `process.env` for real runs.
 */
export function resolveEmbedConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): EmbedConfig {
  return {
    batchSize: parseEnvInt(
      env.BRAIN_EMBED_BATCH_SIZE,
      "BRAIN_EMBED_BATCH_SIZE",
      DEFAULT_EMBED_BATCH_SIZE,
      MIN_EMBED_BATCH_SIZE,
      MAX_EMBED_BATCH_SIZE
    ),
    concurrency: parseEnvInt(
      env.BRAIN_EMBED_CONCURRENCY,
      "BRAIN_EMBED_CONCURRENCY",
      DEFAULT_EMBED_CONCURRENCY,
      MIN_EMBED_CONCURRENCY,
      MAX_EMBED_CONCURRENCY
    ),
  };
}

/** Inputs for resolving which embedding model key a sync/reindex run should use. */
export interface ResolveSyncModelOptions {
  /** BRAIN_EMBED_MODEL env override, if set. Wins unconditionally — this is the documented model-switch path. */
  envModel: string | undefined;
  /** The project's stored table meta (readTableMeta result), or null when the project has no index yet. */
  storedMeta: TableMeta | null;
}

/**
 * Resolve the embedding model key to pass to createEmbeddingClient for a
 * sync/reindex run, in precedence order:
 *   1. Explicit env override (envModel) — deliberate model switch, always wins.
 *   2. The project's stored table meta model — an already-indexed project must
 *      keep using the model it was built with, not the registry default.
 *   3. undefined — no env, no stored meta (fresh project) — the registry
 *      default (DEFAULT_MODEL_KEY) applies downstream in createEmbeddingClient.
 *
 * Pure: no process.env / fs reads here — both inputs are injected by the caller.
 */
export function resolveSyncModel(options: ResolveSyncModelOptions): string | undefined {
  const { envModel, storedMeta } = options;
  if (envModel) return envModel;
  if (storedMeta) return storedMeta.model;
  return undefined;
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

/**
 * Exit code contract for sync/reindex CLIs: any unembedded chunk is a
 * failure (exit 1), not a warning. Automation (CI, git hooks) must be able
 * to detect a partial index without parsing stderr.
 */
export function syncExitCode(result: Pick<SyncResult, "error" | "embedFailed">): number {
  return result.error || result.embedFailed > 0 ? 1 : 0;
}

/** Recursively list all files under a directory, skipping ignored ones. */
async function listAllFiles(
  dir: string,
  root: string,
  gitignorePatterns: string[]
): Promise<string[]> {
  const results: string[] = [];

  let entries: Dirent[];
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
  // When the caller injects a graph (e.g. the long-lived MCP server's shared
  // connection) we USE it and do NOT open/close one — the caller owns its
  // lifecycle. Otherwise we open an ephemeral graph and close it in finally.
  const configDir = join(root, ".project-brain");
  const ownsGraph = !options.graph;
  // Ensure .project-brain/ exists before opening SQLite (may not exist in fresh projects).
  await mkdir(configDir, { recursive: true });
  const graph =
    options.graph ?? new GraphStore(openGraphDb(join(configDir, GRAPH_DB_FILE)));
  // Structural extraction is best-effort: if the WASM parser cannot initialise
  // (e.g. grammar assets missing in an exotic runtime), skip structural work
  // rather than crashing the whole indexer. parseFile is guarded on `parser` below.
  // Construction+init is deferred until AFTER the pool-eligibility gate below
  // (once `filePaths` is known) — when the worker pool takes over, the
  // sequential in-process parser is never needed, so building it eagerly here
  // would be wasted initialisation.
  let parser: WasmParser | null = null;
  // Worker pool for parallel structural parsing on large syncs. Declared here
  // (outside the `try` below) so the sibling `finally` block can dispose it.
  // Assigned inside `try` once `filePaths` — and thus the candidate count — is
  // known. Stays null for small syncs, which fall back to the sequential
  // in-process `parser` above.
  let pool: ParserPool | null = null;
  // SQLite manifest store — always owned by runSync (never injected), closed
  // in the sibling `finally` block below. Declared outside `try` so `finally`
  // can close it even when something inside `try` throws after assignment.
  let manifest: ManifestStore | null = null;

  try {
    const warmedExts = new Set<string>();

    // 1. Open the SQLite manifest store (migrates any legacy hashes.json in
    // its constructor). Replaces the old load-all-JSON-into-memory step —
    // reads below are point lookups (manifest.getEntry), not an in-memory
    // object built from a single monolithic parse.
    manifest = new ManifestStore(root);
    // `const` alias so closures below (flushStore, the Phase A read-batch
    // callback) keep the narrowed non-null type — TS widens captured `let`s
    // back to `T | null` inside closures since it can't prove they're never
    // reassigned before the closure runs.
    const manifestStore = manifest;
    // R2: capture the pre-run path set BEFORE any manifest write this run —
    // the deletion sweep below (full-walk only) must compare against this
    // snapshot, never a live listPaths() call that could already reflect
    // writes made earlier in this same run.
    const priorPaths = new Set(manifestStore.listPaths());

    // 2. Collect files to process
    onProgress?.({ phase: "scanning", current: 0, total: 0 });
    let filePaths: string[];
    if (options.changedFiles && options.changedFiles.length > 0) {
      filePaths = options.changedFiles.map((f) =>
        f.startsWith("/") ? f : join(root, f)
      );
    } else {
      const gitignorePatterns = await loadPatterns(root);
      filePaths = await listAllFiles(root, root, gitignorePatterns);
    }
    onProgress?.({ phase: "scanning", current: filePaths.length, total: filePaths.length });

    // Only worth spawning worker threads when there are enough files that
    // parallel parsing outweighs thread-startup overhead. Below the
    // threshold, `pool` stays null and Phase A falls back to the existing
    // sequential in-process `parser` (constructed above, unconditionally).
    // Pool size must be a positive integer — Math.max(1, ...) guards against a
    // 1-2 core host producing 0/negative (which would hang the pool forever).
    pool = ownsGraph && filePaths.length >= POOL_MIN_FILES ? new ParserPool(
      Math.max(1, (await import("node:os")).cpus().length - 2)
    ) : null;

    // Only construct+init the sequential WasmParser when the pool is NOT
    // taking over — it would sit initialised and unused on the pool path.
    if (!pool) {
      parser = new WasmParser();
      try {
        await parser.init();
      } catch {
        parser = null;
      }
    }

    // 3. Ensure table exists (pass model+dim so metadata is stored correctly)
    const tableMeta = embeddings.model
      ? { model: embeddings.model, dim: embeddings.dim }
      : undefined;
    await store.ensureTable(projectId, tableMeta);

    let ingested = 0;
    let skipped = 0;

    // Pipeline: read all files → embed in large batches → store per mini-wave.
    // mtime fast-path: stat() is ~10x cheaper than file.text() + hash.
    // EMBED_BATCH_SIZE=200: fewer HTTP round-trips to Ollama.
    // SAVE_EVERY=10: batchReplace every 10 files → continuous progress.
    const READ_CONCURRENCY = 20;
    const { batchSize: EMBED_BATCH_SIZE, concurrency: EMBED_CONCURRENCY } = resolveEmbedConfig();
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

          // Normalize backslashes (Windows watcher delivers `\` paths) so graph
          // files.path + manifest keys match the forward-slash keys used by the
          // full-walk path (listAllFiles). Otherwise dedupe breaks on Windows.
          const relPath = (filePath.startsWith(root + "/")
            ? filePath.slice(root.length + 1) : filePath).replace(/\\/g, "/");

          const entry = manifestStore.getEntry(relPath);
          if (entry && entry.mtime === mtime) return "skipped" as const; // mtime unchanged → skip

          // mtime changed → read content + verify hash
          let content: string;
          try { content = await Bun.file(filePath).text(); } catch { return null; }
          const hash = computeHash(content);

          if (entry && entry.hash === hash) {
            // Content identical despite mtime change — update mtime only.
            // Safe to write immediately (not gated behind flushStore): no
            // chunks/vectors change for this file this run, so there is
            // nothing in LanceDB this write could "lead". Matches the prior
            // JSON behavior of not preserving per-chunk hashes on this path
            // (chunks intentionally omitted here, same as before).
            manifestStore.upsertFile(relPath, hash, mtime, {});
            return "skipped" as const;
          }

          const parts = relPath.split("/");
          const module = parts.length > 1 ? parts[0] : "root";

          // Structural graph: parse + extract symbols (gated by same hash-skip above).
          // Skipped entirely when the WASM parser failed to initialise.
          // Dot-less filenames (e.g. "Makefile") have no extension → "".
          const dotIdx = relPath.lastIndexOf(".");
          const ext = dotIdx < 0 ? "" : relPath.slice(dotIdx);
          // Best-effort: a single malformed/unsupported file must NOT abort the
          // whole sync (which would also kill embedding of every other file).
          // Any throw from warm/parse/extract is logged and structural work for
          // this file is skipped; embedding still proceeds below.
          // Populated when structural extraction succeeds — fed into
          // chunkContent below so code files get real AST-derived (cAST)
          // chunk boundaries instead of the regex/brace-counter fallback.
          // Stays empty on parse failure, unsupported extensions, or when
          // the WASM parser could not initialise — chunkContent falls back
          // to the legacy splitter automatically when boundaries is empty.
          let boundaries: ReturnType<typeof extractBoundaries> = [];

          try {
            if (pool) {
              const result = await pool.parseOne({ path: relPath, content, ext });
              if (result.error) {
                console.warn(`[sync] structural extraction skipped for ${relPath}:`, result.error);
              } else if (result.langId) {
                graph.replaceFile(relPath, result.langId, hash, mtime, result.symbols);
                boundaries = result.boundaries;
              }
            } else {
              if (parser && !warmedExts.has(ext)) {
                await parser.warm(ext);
                warmedExts.add(ext);
              }
              const pt = parser?.parseFile(ext, content) ?? null;
              if (pt) {
                try {
                  const syms = extract(pt.tree, pt.langId, content);
                  graph.replaceFile(relPath, pt.langId, hash, mtime, syms);
                  boundaries = extractBoundaries(pt.tree, pt.langId);
                } finally {
                  pt.tree.delete();
                }
              }
            }
          } catch (err) {
            console.warn(`[sync] structural extraction skipped for ${relPath}:`, err instanceof Error ? err.message : err);
          }

          return { relPath, hash, mtime, rawChunks: chunkContent(content, relPath, module, boundaries) };
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

    // Collect unchanged-chunk ids first — one batched lookup (getChunksByIds)
    // instead of N sequential round-trips, the dominant cost on a normal
    // incremental sync where most chunks are unchanged. Falls back to the
    // per-id loop when the injected store doesn't implement the batch method.
    type UnchangedInfo = { entryIdx: number; chunkIdx: number; id: string };
    const unchangedInfos: UnchangedInfo[] = [];

    for (let ei = 0; ei < pendingEntries.length; ei++) {
      const entry = pendingEntries[ei];
      const prevEntry = manifestStore.getEntry(entry.relPath);
      const prevChunkHashes: Record<string, string> = prevEntry?.chunks ?? {};
      // ManifestStore.getEntry always returns a (possibly empty) chunks
      // object rather than undefined (unlike the old JSON shape, where an
      // old-format entry had no `chunks` key at all). That distinction is
      // moot here: when chunks is empty, every chunk id lookup below misses
      // and prevHash is undefined, forcing chunkChanged=true regardless of
      // this flag's value — so `!!prevEntry` is behaviorally equivalent to
      // the old `!!prevEntry?.chunks` for every reachable case.
      const hasChunkManifest = !!prevEntry;

      for (let ci = 0; ci < entry.rawChunks.length; ci++) {
        const raw = entry.rawChunks[ci];
        const prevHash = prevChunkHashes[raw.id];
        const chunkChanged = !hasChunkManifest || prevHash !== raw.content_hash;

        if (!chunkChanged) {
          unchangedInfos.push({ entryIdx: ei, chunkIdx: ci, id: raw.id });
        } else {
          changedChunkInfos.push({ entryIdx: ei, chunkIdx: ci });
          textsToEmbed.push(raw.content);
        }
      }
    }

    if (unchangedInfos.length > 0) {
      const storedById = store.getChunksByIds
        ? await store.getChunksByIds(projectId, unchangedInfos.map((u) => u.id))
        : null;

      for (const { entryIdx, chunkIdx, id } of unchangedInfos) {
        const stored = storedById
          ? storedById.get(id)
          : await store.getChunkById(projectId, id); // fallback: store has no batch method

        if (stored) {
          reusedVectors[entryIdx][chunkIdx] = stored.vector;
        } else {
          // Stored vector not found (e.g., store was wiped) — re-embed as fallback
          changedChunkInfos.push({ entryIdx, chunkIdx });
          textsToEmbed.push(pendingEntries[entryIdx].rawChunks[chunkIdx].content);
        }
      }
    }

    // Embed only the changed/new chunks in EMBED_BATCH_SIZE batches
    const embeddedVectors: (number[] | null)[] = new Array(textsToEmbed.length).fill(null);
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

    // Resilience fallback: a concurrent embedding pass can fail wholesale
    // when Ollama's backing llama-server crashes under concurrent load —
    // even though single/sequential requests are reliable (confirmed live
    // and in the engram spike/lexical-graph-quality side-findings). Rather
    // than aborting the whole sync, retry ONLY the failed texts sequentially
    // (concurrency=1, smaller batches) before giving up.
    //
    // Breaker interaction: OllamaEmbeddingClient opens its circuit breaker
    // (HEALTH_COOLDOWN_MS = 30s) on failure, so a naive retry right after a
    // concurrent-pass failure would hit an OPEN breaker and get an instant
    // null with no network attempt. We call embeddings.reset() once, right
    // before this one deliberate recovery pass, to bypass that cooldown.
    // reset() is optional/duck-typed on EmbeddingClient — clients without a
    // breaker (test fakes, future implementations) simply don't have it, and
    // the fallback still runs (network calls are attempted either way; reset
    // only matters for clients WITH a breaker). The breaker's normal-operation
    // purpose (don't hammer a genuinely-down Ollama) stays intact: we only
    // bypass it for this single explicit recovery attempt, never routinely.
    if (embedFailed > 0) {
      const failedIndices: number[] = [];
      for (let i = 0; i < embeddedVectors.length; i++) {
        if (embeddedVectors[i] === null) failedIndices.push(i);
      }

      if (failedIndices.length > 0) {
        console.warn(
          `[sync] Embedding under load failed at concurrency=${EMBED_CONCURRENCY}; retrying sequentially...`
        );
        embeddings.reset?.();

        const SEQUENTIAL_BATCH_SIZE = Math.min(EMBED_BATCH_SIZE, 8);
        const sequentialBatches: Array<{ indices: number[]; texts: string[] }> = [];
        for (let i = 0; i < failedIndices.length; i += SEQUENTIAL_BATCH_SIZE) {
          const idxSlice = failedIndices.slice(i, i + SEQUENTIAL_BATCH_SIZE);
          sequentialBatches.push({
            indices: idxSlice,
            texts: idxSlice.map((idx) => textsToEmbed[idx]),
          });
        }

        await mapLimit(sequentialBatches, 1, async ({ indices, texts }) => {
          const vecs = await embeddings.embed(texts);
          if (vecs) {
            for (let j = 0; j < vecs.length; j++) {
              embeddedVectors[indices[j]] = vecs[j];
              embedFailed--;
            }
            embedDone = Math.min(embedDone + vecs.length, textsToEmbed.length);
            onProgress?.({ phase: "embedding", current: embedDone, total: textsToEmbed.length });
          }
          // On failure, the indices stay null / embedFailed stays counted —
          // same "report real error, nothing partially corrupt" guarantee
          // as the pre-fallback behavior (5beac8f).
        });
      }
    }

    // Distribute embedded vectors back into reusedVectors
    for (let i = 0; i < changedChunkInfos.length; i++) {
      const { entryIdx, chunkIdx } = changedChunkInfos[i];
      reusedVectors[entryIdx][chunkIdx] = embeddedVectors[i];
    }

    // Phase C: store every SAVE_EVERY files → progress updates, few fragments
    let storeBuf: { sources: string[]; chunks: Chunk[] } = { sources: [], chunks: [] };

    // R1: manifest writes for files in the current storeBuf are buffered
    // here and applied ONLY after the covering flushStore()'s batchReplace()
    // succeeds — the manifest must never lead LanceDB in durability. Every
    // push into storeBuf.chunks below is paired 1:1 with a push here, so
    // manifestBuf is empty exactly when storeBuf.chunks is empty.
    type ManifestOp =
      | { kind: "upsert"; path: string; hash: string; mtime: number; chunks: Record<string, string> }
      | { kind: "delete"; path: string };
    let manifestBuf: ManifestOp[] = [];

    async function flushStore() {
      if (storeBuf.chunks.length === 0) return;
      await store.batchReplace(projectId, storeBuf.sources, storeBuf.chunks);
      // Only reached once the store write above has succeeded.
      for (const op of manifestBuf) {
        if (op.kind === "upsert") manifestStore.upsertFile(op.path, op.hash, op.mtime, op.chunks);
        else manifestStore.deleteFile(op.path);
      }
      storeBuf = { sources: [], chunks: [] };
      manifestBuf = [];
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
          // RawChunk.symbol_kind is SymbolKind since parser.ts/extract.ts were
          // made honest at the source — no assertion needed anymore.
          symbol_kind: raw.symbol_kind,
          signature: raw.signature,
          start_line: raw.start_line,
          end_line: raw.end_line,
        }));

      if (entryChunks.length === 0) continue;
      storeBuf.sources.push(entry.relPath);
      storeBuf.chunks.push(...entryChunks);

      // Only mark this file "synced" in the manifest if EVERY one of its
      // chunks actually embedded. Recording entry.hash unconditionally would
      // make the top-level `entry.hash === hash` check (above) treat this
      // file as unchanged forever, permanently skipping the chunks that
      // failed — silent, undetectable data loss surviving even future
      // reindexes. Leaving the manifest entry stale/absent forces this file
      // to be reprocessed (and its missing chunks retried) next sync.
      // Both branches are buffered into manifestBuf — applied by flushStore()
      // only after THIS file's chunks are durably stored (R1); the delete
      // branch is gated the same way even though its file was never fully
      // stored, for a single consistent apply-after-flush rule.
      if (entryChunks.length === entry.rawChunks.length) {
        const chunkHashes: Record<string, string> = {};
        for (const raw of entry.rawChunks) {
          chunkHashes[raw.id] = raw.content_hash;
        }
        manifestBuf.push({ kind: "upsert", path: entry.relPath, hash: entry.hash, mtime: entry.mtime, chunks: chunkHashes });
      } else {
        manifestBuf.push({ kind: "delete", path: entry.relPath });
      }
      ingested++;
      onProgress?.({ phase: "storing", current: ingested, total: totalChanged });

      // Flush every SAVE_EVERY files
      if (storeBuf.sources.length >= SAVE_EVERY) await flushStore();
    }
    await flushStore(); // flush remainder

    // Resolve cross-file call edges for every file that was parsed this run,
    // batched into a single transaction instead of one autocommit pair of
    // UPDATEs per file.
    graph.resolveEdgesForFiles(pendingEntries.map((entry) => entry.relPath));

    // 5. Detect deleted files (in manifest but no longer on disk).
    //    ONLY the authoritative full walk can do this: on the incremental
    //    (changedFiles) path `filePaths` holds just the changed files, so every
    //    OTHER indexed file would miss `currentRels` and be wiped from the store,
    //    graph, and manifest on every watcher save. Incremental syncs therefore
    //    never delete; real deletions are reconciled on the next full sync.
    // Mirror the file-collection predicate (line ~190): an empty changedFiles
    // array means "full walk, hash-gated" (the `--changed-only` CLI flag), which
    // CAN authoritatively detect deletions. Only a NON-EMPTY changedFiles list
    // (the watcher's incremental path) must skip deletion — otherwise every
    // unprocessed file would be wiped. Keep both guards' empty-array semantics in
    // lockstep.
    let deleted = 0;
    if (!options.changedFiles || options.changedFiles.length === 0) {
      // Normalize backslashes so these keys match the forward-slash manifest keys
      // (set during the read phase). Without this, on Windows EVERY manifest entry
      // misses currentRels and gets spuriously deleted.
      const currentRels = new Set(
        filePaths.map((f) =>
          (f.startsWith(root + "/") ? f.slice(root.length + 1) : f).replace(/\\/g, "/")
        )
      );
      for (const relPath of priorPaths) {
        if (!currentRels.has(relPath)) {
          await store.deleteBySource(projectId, relPath);
          graph.deleteFile(relPath);
          manifestStore.deleteFile(relPath);
          deleted++;
        }
      }
    }

    // Repair stale edge links after structural mutation. SQLite reuses rowids,
    // so a removed symbol's id can be reassigned — edges in OTHER files keeping
    // the stale dst_symbol_id would make `impact`/`findCallers` traverse the
    // wrong symbol. This happens on REPLACE too, not just delete: editing a file
    // to rename/remove a symbol cascade-deletes its old rows, but edges in
    // unchanged files (not in pendingEntries) are never revisited by
    // resolveEdgesForFile. So prune whenever anything was replaced or deleted.
    // Pure no-op syncs (nothing changed) skip the two full-table scans.
    if (deleted > 0 || pendingEntries.length > 0) {
      graph.pruneDanglingEdges();
    }

    // 6. Build FTS + vector indexes so hybridSearch works
    await store.buildIndexes(projectId);

    // 7. Manifest is already durable — every write above (Phase A mtime
    // refresh, Phase C per-file upsert/delete, the deletion sweep) commits
    // directly via ManifestStore's own transactions. No wholesale rewrite
    // step needed anymore.

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
    // 8. Dispose structural graph resources. The WASM parser and worker pool
    // are always ephemeral. The graph is closed ONLY when runSync opened it —
    // an injected graph belongs to the caller (the MCP server) and must stay
    // open. The manifest store is always owned by runSync (never injected).
    if (parser) { try { parser.dispose(); } catch {} }
    if (pool) { try { pool.dispose(); } catch {} }
    if (ownsGraph) { try { graph.close(); } catch {} }
    if (manifest) { try { manifest.close(); } catch {} }
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

  const manifest = new ManifestStore(root);
  try {
    const gitignorePatterns = await loadPatterns(root);
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

      const relPath = (filePath.startsWith(root + "/")
        ? filePath.slice(root.length + 1)
        : filePath).replace(/\\/g, "/");
      const hash = computeHash(content);

      const entry = manifest.getEntry(relPath);
      if (entry && entry.hash === hash) {
        current++;
      } else {
        stale++;
      }
    }

    return { stale, current, total: filePaths.length };
  } finally {
    manifest.close();
  }
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
  const { readTableMeta } = await import("../store/meta.js");
  const store = new LanceDbStore(DB_PATH);

  // Prefer the model the project's index was already built with (stored table
  // meta) over the registry default — otherwise sync on an existing project
  // built with a non-default model (e.g. nomic-embed-text) tries to embed with
  // the CURRENT registry default (qwen3-embedding), causing a dim mismatch and
  // total embed failure. An explicit BRAIN_EMBED_MODEL override still wins
  // (deliberate model-switch path).
  const storedMeta = await readTableMeta(DB_PATH, projectId);
  const embeddings = await createEmbeddingClient(resolveSyncModel({ envModel: process.env.BRAIN_EMBED_MODEL || undefined, storedMeta }), { host: OLLAMA_HOST, autoPull: true });

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
    console.log("\nSync incomplete.");
    process.exit(syncExitCode(result));
  }
  console.log("\nSync complete.");
}
