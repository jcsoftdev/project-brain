import { join } from "node:path";
import { open, unlink } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import { Index, rerankers } from "@lancedb/lancedb";
import type { IvfPqOptions } from "@lancedb/lancedb";
import { ANN_INDEX_MIN_ROWS, EMBEDDING_MODEL, TABLE_SUFFIX, VECTOR_DIM } from "../constants.js";
import { readTableMeta, writeTableMeta } from "./meta.js";
import type { TableMeta } from "./meta.js";
import type { Chunk, SearchResult, VectorStore, SymbolKind } from "../types.js";

/** Sanitize project name for use as table name. */
function sanitizeProject(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
}

const SYMBOL_KINDS = new Set<SymbolKind>([
  "function", "method", "class", "interface", "type",
  "enum", "struct", "impl", "trait", "variable", "section", "unknown",
]);

/** Validate an untyped LanceDB row field against the known SymbolKind union. Unknown/malformed values map to "unknown" rather than silently passing through. */
function asSymbolKind(s: string | undefined): SymbolKind | undefined {
  if (s === undefined) return undefined;
  return (SYMBOL_KINDS as Set<string>).has(s) ? (s as SymbolKind) : "unknown";
}

/**
 * True when `err` is lance's specific "no INVERTED index" error — the
 * expected condition when fullTextSearch() runs against a table that never
 * had buildIndexes() called (e.g. brand-new or tiny tables). This is NOT a
 * genuine failure and must not be logged as one.
 */
function isMissingFtsIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("INVERTED index");
}

/** Max number of table handles (and their module-list caches) kept alive at
 * once. `project` is an arbitrary string per MCP call and the serve process
 * is long-lived, so the map must be bounded to avoid unbounded growth. */
const TABLE_CACHE_MAX = 16;

/**
 * How far back optimize() keeps superseded versions. Matches lance's own
 * conservative default; the fix for unbounded growth is preventing concurrent
 * optimizes, not shortening this.
 */
const OPTIMIZE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A lock older than this is treated as abandoned. An optimize on a large table
 * legitimately runs for many minutes, so this must comfortably exceed that —
 * but a process killed mid-optimize (as happened in the field) must not wedge
 * every future run.
 */
const OPTIMIZE_LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * Cross-process advisory lock for optimize, held as a file next to the dataset.
 *
 * Returns a release function, or null when another live process holds it — in
 * which case the caller skips its own optimize entirely rather than queueing.
 * Skipping is correct: optimize is idempotent maintenance, so the holder's run
 * subsumes ours.
 */
async function acquireOptimizeLock(
  dbPath: string,
  key: string
): Promise<(() => Promise<void>) | null> {
  const lockPath = join(dbPath, `${key}.optimize.lock`);

  const write = async () => {
    // `wx` fails when the file exists — the atomic test-and-set this needs.
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    await handle.close();
  };

  try {
    await write();
  } catch {
    // Held, or unreadable. Take it over only if it is provably stale.
    let stale = false;
    try {
      const raw = await Bun.file(lockPath).text();
      const at = JSON.parse(raw)?.at;
      stale = typeof at !== "number" || Date.now() - at > OPTIMIZE_LOCK_STALE_MS;
    } catch {
      // Unparseable lock — a crash mid-write. Treat as stale.
      stale = true;
    }
    if (!stale) return null;

    try {
      await unlink(lockPath);
      await write();
    } catch {
      return null; // lost the race to another taker
    }
  }

  return async () => {
    await unlink(lockPath).catch(() => {});
  };
}

/** LanceDB-backed vector store implementation. */
export class LanceDbStore implements VectorStore {
  /** In-flight optimize per table, so repeated syncs coalesce onto one run. */
  private optimizeInFlight = new Map<string, Promise<void>>();
  /** Same, for buildIndexes — a watcher can fire again mid-build. */
  private buildInFlight = new Map<string, Promise<void>>();
  private db: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
  private readonly dbPath: string;
  private tables = new Map<string, Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>["openTable"]>>>();
  private reranker: Awaited<ReturnType<typeof rerankers.RRFReranker.create>> | null = null;
  /** Distinct-module list per project, keyed by table name. Invalidated on any write path.
   * Evicted alongside its table entry — a project without an open table handle
   * has no business keeping a cached module list either. */
  private modulesCache = new Map<string, string[]>();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async getDb() {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  private tableName(project: string): string {
    return `${sanitizeProject(project)}${TABLE_SUFFIX}`;
  }

  /** Read a cached table handle and mark it most-recently-used (Map preserves
   * insertion order — delete+re-set moves the key to the end). */
  private getCachedTable(name: string) {
    const table = this.tables.get(name);
    if (table !== undefined) {
      this.tables.delete(name);
      this.tables.set(name, table);
    }
    return table;
  }

  /** Insert/refresh a table handle, evicting the least-recently-used entry
   * (the Map's first key) once the cache exceeds TABLE_CACHE_MAX. Its
   * modules cache entry is evicted alongside it. */
  private setCachedTable(name: string, table: Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>["openTable"]>>) {
    this.tables.delete(name);
    this.tables.set(name, table);
    while (this.tables.size > TABLE_CACHE_MAX) {
      const oldest = this.tables.keys().next().value;
      if (oldest === undefined) break;
      this.tables.delete(oldest);
      this.modulesCache.delete(oldest);
    }
  }

  /** Lazily construct the RRFReranker once and reuse it — params are constant (no arguments), so a fresh instance per hybridSearch call is wasted work. */
  private async getReranker() {
    if (!this.reranker) {
      this.reranker = await rerankers.RRFReranker.create();
    }
    return this.reranker;
  }

  private async getTable(project: string) {
    const name = this.tableName(project);
    const cached = this.getCachedTable(name);
    if (cached !== undefined) {
      return cached;
    }
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(name)) {
      return null;
    }
    const table = await db.openTable(name);
    this.setCachedTable(name, table);
    return table;
  }

  async ensureTable(project: string, meta: TableMeta = { model: EMBEDDING_MODEL, dim: VECTOR_DIM }): Promise<void> {
    const name = this.tableName(project);
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(name)) {
      // Table already exists — open it (or use cached handle) and check the vector dim.
      let table = this.getCachedTable(name);
      if (!table) {
        table = await db.openTable(name);
        this.setCachedTable(name, table);
      }

      // Read the actual vector dim from the Arrow schema.
      // The "vector" field type is a FixedSizeList whose size gives the dim.
      let existingDim: number | undefined;
      try {
        const schema = await table.schema();
        const vectorField = schema.fields.find((f: { name: string }) => f.name === "vector");
        const listSize = (vectorField?.type as { listSize?: number } | undefined)?.listSize;
        if (typeof listSize === "number") existingDim = listSize;
      } catch {
        // schema() not available — fall through to no-drop path
      }

      // If dims match (or we couldn't detect), keep the table as-is.
      if (existingDim === undefined || existingDim === meta.dim) {
        return;
      }

      // Dims differ → the stored vectors are incompatible. Drop and recreate.
      process.stderr.write(
        `[project-brain] embedding dim changed (${existingDim} -> ${meta.dim}) for '${project}'; rebuilding table.\n`
      );
      this.tables.delete(name);
      this.modulesCache.delete(name);
      await db.dropTable(name);
      // Fall through to the create-table path below.
    }
    // Create with a seed record that we immediately delete
    const seed = {
      id: "__seed__",
      vector: new Array(meta.dim).fill(0),
      content: "",
      source: "__seed__",
      module: "__seed__",
      content_hash: "",
      updated_at: 0,
      symbol_name: "",
      symbol_kind: "",
      signature: "",
      start_line: 0,
      end_line: 0,
    };
    const table = await db.createTable(name, [seed]);
    await table.delete("id = '__seed__'");
    this.setCachedTable(name, table);
    this.modulesCache.delete(name);
    await writeTableMeta(this.dbPath, project, meta);
  }

  async upsert(project: string, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getTable(project);
    if (!table) {
      throw new Error(`Table for project '${project}' does not exist. Call ensureTable first.`);
    }
    const ids = chunks.map((c) => `'${c.id.replace(/'/g, "''")}'`).join(", ");
    await table.delete(`id IN (${ids})`);
    await table.add(chunks.map((c) => ({
      id: c.id, vector: c.vector, content: c.content,
      source: c.source, module: c.module,
      content_hash: c.content_hash, updated_at: c.updated_at,
      symbol_name: c.symbol_name ?? "",
      symbol_kind: c.symbol_kind ?? "",
      signature: c.signature ?? "",
      start_line: c.start_line ?? 0,
      end_line: c.end_line ?? 0,
    })));
    this.modulesCache.delete(this.tableName(project));
  }

  /** Delete N sources then insert all chunks in ONE add() call — 1 fragment per wave. */
  async batchReplace(project: string, sources: string[], chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getTable(project);
    if (!table) {
      throw new Error(`Table for project '${project}' does not exist. Call ensureTable first.`);
    }
    // Delete all sources in ONE call instead of N round-trips.
    if (sources.length > 0) {
      const list = sources.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
      await table.delete(`source IN (${list})`);
    }
    // ONE add() for all chunks → ONE fragment (vs N fragments with per-file upsert)
    await table.add(chunks.map((c) => ({
      id: c.id, vector: c.vector, content: c.content,
      source: c.source, module: c.module,
      content_hash: c.content_hash, updated_at: c.updated_at,
      symbol_name: c.symbol_name ?? "",
      symbol_kind: c.symbol_kind ?? "",
      signature: c.signature ?? "",
      start_line: c.start_line ?? 0,
      end_line: c.end_line ?? 0,
    })));
    this.modulesCache.delete(this.tableName(project));
  }

  async search(project: string, vector: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      // No countRows() pre-check: vectorSearch() on an empty table returns []
      // naturally — the extra round-trip bought nothing.
      const results = await table.vectorSearch(vector).limit(topK).toArray();
      return results.map((r) => ({
        id: r.id as string,
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        score: 1 / (1 + (r._distance as number)),
        symbol_name: r.symbol_name as string | undefined,
        symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
    } catch (err) {
      // A genuine failure (dim mismatch, connection error, corrupted
      // fragment) must not be silently indistinguishable from "no matches" —
      // log so a broken index isn't invisible, then degrade to [] (search()
      // is called from hot paths that expect a result array, not a throw).
      console.warn(
        `[project-brain] search failed for '${project}':`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  async deleteBySource(project: string, source: string): Promise<void> {
    const table = await this.getTable(project);
    if (!table) {
      return;
    }
    await table.delete(`source = '${source.replace(/'/g, "''")}'`);
    this.modulesCache.delete(this.tableName(project));
  }

  async listModules(project: string): Promise<string[]> {
    const name = this.tableName(project);
    const cached = this.modulesCache.get(name);
    if (cached) {
      return [...cached];
    }
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      // No countRows() pre-check: query().toArray() on an empty table
      // returns [] naturally — the extra round-trip bought nothing.
      const rows = await table.query().select(["module"]).toArray();
      const modules = [...new Set(rows.map((r) => r.module as string))];
      modules.sort();
      this.modulesCache.set(name, modules);
      return [...modules];
    } catch (err) {
      // No FTS involved here, so any catch is a genuine failure — must not
      // be silently indistinguishable from "no modules".
      console.warn(
        `[project-brain] listModules failed for '${project}':`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  async getModuleChunks(project: string, module: string): Promise<Chunk[]> {
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      // No countRows() pre-check: query().toArray() on an empty table
      // returns [] naturally — the extra round-trip bought nothing.
      const rows = await table
        .query()
        .where(`module = '${module.replace(/'/g, "''")}'`)
        .toArray();
      const chunks: Chunk[] = rows.map((r) => ({
        id: r.id as string,
        vector: Array.from(r.vector as number[]),
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        content_hash: r.content_hash as string,
        updated_at: r.updated_at as number,
        symbol_name: r.symbol_name as string | undefined,
        symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
      return chunks.sort((a, b) => a.source.localeCompare(b.source));
    } catch (err) {
      // No FTS involved here, so any catch is a genuine failure — must not
      // be silently indistinguishable from "no chunks".
      console.warn(
        `[project-brain] getModuleChunks failed for '${project}':`,
        err instanceof Error ? err.message : err
      );
      return [];
    }
  }

  async countChunks(project: string): Promise<number> {
    const table = await this.getTable(project);
    if (!table) {
      return 0;
    }
    try {
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  /**
   * Compact the table and prune superseded versions.
   *
   * Serialised twice over, because this operation cost 181GB of index garbage
   * and three runaway processes in the field:
   *
   * 1. In-process, via `optimizeInFlight` — a watcher can fire several syncs
   *    while one optimize is still running.
   * 2. Across processes, via a lock file — every `serve` starts its own
   *    FileWatcher, and two servers on the same project is normal (one per MCP
   *    host). An in-process lock is blind to that.
   *
   * There is deliberately NO timeout. The previous implementation raced
   * optimize() against a 10s timer, but Promise.race only stops *awaiting* —
   * lance's operation kept running, uncancelled and now unobserved, while the
   * next sync launched another one on top of it.
   */
  async optimize(project: string): Promise<void> {
    const key = sanitizeProject(project) + TABLE_SUFFIX;

    const inFlight = this.optimizeInFlight.get(key);
    if (inFlight) return inFlight;

    const run = this.runOptimize(project, key).finally(() => {
      this.optimizeInFlight.delete(key);
    });
    this.optimizeInFlight.set(key, run);
    return run;
  }

  private async runOptimize(project: string, key: string): Promise<void> {
    const table = await this.getTable(project);
    if (!table) return;

    const release = await acquireOptimizeLock(this.dbPath, key);
    if (!release) return; // another process holds it — its work covers ours

    try {
      await this.compact(table);
    } finally {
      await release();
    }
  }

  /** The compaction itself, with the lock assumed already held. */
  private async compact(table: any): Promise<void> {
    try {
      // An explicit retention window: called with no options, lance keeps every
      // version, and 15,873 of them accumulated against 3GB of real content.
      // `deleteUnverified` stays false — it would delete files belonging to an
      // in-progress transaction in a process this lock cannot see.
      const cleanupOlderThan = new Date(Date.now() - OPTIMIZE_RETENTION_MS);
      await table.optimize({ cleanupOlderThan });
    } catch {
      // Non-fatal: a failed compaction leaves the table queryable.
    }
  }

  /**
   * Build the FTS + vector indexes, then compact.
   *
   * Serialized by the SAME lock as optimize, and for a harder-won reason:
   * locking optimize alone left `createIndex` exposed, and that is where the
   * real damage was. Two watchers on one project each wrote a FULL index copy,
   * which is how _indices reached 35GB against 1.18GB of vectors. The lock has
   * to span index creation and compaction as one unit.
   */
  async buildIndexes(
    project: string,
    opts?: { annMinRows?: number; ivfPqOptions?: Partial<IvfPqOptions> }
  ): Promise<void> {
    const key = sanitizeProject(project) + TABLE_SUFFIX;

    const inFlight = this.buildInFlight.get(key);
    if (inFlight) return inFlight;

    const run = this.runBuildIndexes(project, key, opts).finally(() => {
      this.buildInFlight.delete(key);
    });
    this.buildInFlight.set(key, run);
    return run;
  }

  private async runBuildIndexes(
    project: string,
    key: string,
    opts?: { annMinRows?: number; ivfPqOptions?: Partial<IvfPqOptions> }
  ): Promise<void> {
    const table = await this.getTable(project);
    if (!table) return;

    const release = await acquireOptimizeLock(this.dbPath, key);
    if (!release) return; // another process is already doing this work

    try {
    try {
      await table.createIndex("content", { config: Index.fts() });
    } catch {
      // Index may already exist or table has too few rows — non-fatal
    }
    // Vector ANN index: without it every query is an exact O(n) scan over
    // all vectors — fine for small repos, linear-degrading for large ones.
    // IVF_PQ defaults (numPartitions ≈ sqrt(rows), auto subvectors) are
    // fine; we only gate on size so tiny tables keep exact search.
    const annMinRows = opts?.annMinRows ?? ANN_INDEX_MIN_ROWS;
    let hasVectorIndex = false;
    try {
      const indices = await table.listIndices();
      hasVectorIndex = indices.some((ix) => ix.columns.includes("vector"));
    } catch {
      // listIndices() unavailable — fall through and let createIndex's own
      // try/catch below handle the "already exists" case defensively.
    }
    try {
      const rows = await table.countRows();
      if (rows >= annMinRows && !hasVectorIndex) {
        await table.createIndex("vector", { config: Index.ivfPq(opts?.ivfPqOptions) });
        hasVectorIndex = true;
      }
    } catch {
      // Non-fatal: brute-force vector scan still works without the index.
    }
    // Vectors added after the index was built aren't covered by it until the
    // table is optimized — re-optimize whenever a vector index is present
    // (freshly created or pre-existing) so index staleness doesn't silently
    // degrade newly-added rows back to brute-force scan.
    if (hasVectorIndex) {
      await this.compact(table);
    }
    } finally {
      await release();
    }
  }

  async hybridSearch(project: string, vector: number[], text: string, topK: number): Promise<SearchResult[]> {
    const table = await this.getTable(project);
    if (!table) return [];
    try {
      // No countRows() pre-check: fullTextSearch() on an empty table (with
      // an FTS index built) returns [] naturally. A table with NO FTS index
      // throws — that's the expected "tiny/new table" case handled below by
      // falling back to search(), which independently logs genuine failures.
      const reranker = await this.getReranker();
      const rows = await table.query()
        .nearestTo(vector)
        .fullTextSearch(text)
        .rerank(reranker)
        .limit(topK)
        .toArray();
      return rows.map((r) => ({
        id: r.id as string,
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        score: 1 / (1 + ((r._distance as number) ?? 0)),
        symbol_name: r.symbol_name as string | undefined,
        symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
    } catch {
      // FTS index may be missing on tiny tables — fall back to pure vector search
      return this.search(project, vector, topK);
    }
  }

  /** FTS-only keyword search (BM25) — no vector/embeddings involved. Falls back to [] on missing FTS index or empty/missing table. */
  async ftsSearch(project: string, query: string, topK: number): Promise<SearchResult[]> {
    const table = await this.getTable(project);
    if (!table) return [];
    try {
      // No countRows() pre-check: fullTextSearch() on an empty table (with
      // an FTS index built) returns [] naturally.
      const rows = await table.query().fullTextSearch(query).limit(topK).toArray();
      return rows.map((r) => ({
        id: r.id as string,
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        score: (r._score as number) ?? 1,
        symbol_name: r.symbol_name as string | undefined,
        symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
    } catch (err) {
      // Unlike hybridSearch, there's no fallback path here — a missing FTS
      // index (tiny/new table, never had buildIndexes() called) is an
      // EXPECTED condition and must stay silent. Any OTHER failure is genuine
      // and must be logged, exactly like search()'s pattern.
      if (!isMissingFtsIndexError(err)) {
        console.warn(
          `[project-brain] ftsSearch failed for '${project}':`,
          err instanceof Error ? err.message : err
        );
      }
      return [];
    }
  }

  async assertDim(project: string, queryDim: number): Promise<void> {
    const meta = await readTableMeta(this.dbPath, project);
    if (meta && meta.dim !== queryDim) {
      throw new Error(`Vector dim mismatch for '${project}': table=${meta.dim}, query=${queryDim}. Reindex with the matching model.`);
    }
  }

  async getChunkById(project: string, id: string): Promise<import("../types.js").Chunk | null> {
    const table = await this.getTable(project);
    if (!table) return null;
    try {
      const rows = await table.query().where(`id = '${id.replace(/'/g, "''")}'`).limit(1).toArray();
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id as string,
        vector: Array.from(r.vector as number[]),
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        content_hash: r.content_hash as string,
        updated_at: r.updated_at as number,
        symbol_name: r.symbol_name as string | undefined,
        symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      };
    } catch { return null; }
  }

  async getChunksByIds(project: string, ids: string[]): Promise<Map<string, import("../types.js").Chunk>> {
    const result = new Map<string, import("../types.js").Chunk>();
    if (ids.length === 0) return result;
    const table = await this.getTable(project);
    if (!table) return result;
    try {
      const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
      const rows = await table.query().where(`id IN (${list})`).toArray();
      for (const r of rows) {
        result.set(r.id as string, {
          id: r.id as string,
          vector: Array.from(r.vector as number[]),
          content: r.content as string,
          source: r.source as string,
          module: r.module as string,
          content_hash: r.content_hash as string,
          updated_at: r.updated_at as number,
          symbol_name: r.symbol_name as string | undefined,
          symbol_kind: asSymbolKind(r.symbol_kind as string | undefined),
          signature: r.signature as string | undefined,
          start_line: r.start_line as number | undefined,
          end_line: r.end_line as number | undefined,
        });
      }
    } catch {
      // Table exists but query failed (e.g. malformed IN-list) — return
      // whatever was already collected rather than throwing; callers treat
      // missing ids as "needs re-embedding", which is always safe.
    }
    return result;
  }

  async listProjects(): Promise<Array<{ project: string; chunks: number; model?: string; dim?: number }>> {
    const db = await this.getDb();
    const names = await db.tableNames();
    const projectNames = names.filter((name) => name.endsWith(TABLE_SUFFIX));
    // Run each project's countChunks + readTableMeta lookups concurrently
    // instead of sequentially — Promise.all preserves the input order in its
    // resolved array regardless of individual settle order, so this stays a
    // straight drop-in for the previous for-loop.
    const out = await Promise.all(
      projectNames.map(async (name) => {
        const project = name.slice(0, -TABLE_SUFFIX.length);
        const [chunks, meta] = await Promise.all([
          this.countChunks(project),
          readTableMeta(this.dbPath, project),
        ]);
        return { project, chunks, ...(meta ? { model: meta.model, dim: meta.dim } : {}) };
      })
    );
    return out;
  }

  /** Drop a project's vector table + meta file ONLY — never touches any project-local `.project-brain/` directory. */
  /** Raw table names in the store — what prune classifies over. */
  async listTables(): Promise<string[]> {
    const db = await this.getDb();
    return db.tableNames();
  }

  async deleteProject(project: string): Promise<boolean> {
    const name = this.tableName(project);
    const db = await this.getDb();
    if (!(await db.tableNames()).includes(name)) return false;
    this.tables.delete(name);
    this.modulesCache.delete(name);
    await db.dropTable(name);
    const { deleteTableMeta } = await import("./meta.js");
    await deleteTableMeta(this.dbPath, project);
    return true;
  }
}
