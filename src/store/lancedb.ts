import * as lancedb from "@lancedb/lancedb";
import { Index, rerankers } from "@lancedb/lancedb";
import { EMBEDDING_MODEL, TABLE_SUFFIX, VECTOR_DIM } from "../constants.js";
import { readTableMeta, writeTableMeta } from "./meta.js";
import type { TableMeta } from "./meta.js";
import type { Chunk, SearchResult, VectorStore } from "../types.js";

/** Sanitize project name for use as table name. */
function sanitizeProject(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
}

/** LanceDB-backed vector store implementation. */
export class LanceDbStore implements VectorStore {
  private db: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
  private readonly dbPath: string;
  private tables = new Map<string, Awaited<ReturnType<Awaited<ReturnType<typeof lancedb.connect>>["openTable"]>>>();

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

  private async getTable(project: string) {
    const name = this.tableName(project);
    if (this.tables.has(name)) {
      return this.tables.get(name)!;
    }
    const db = await this.getDb();
    const names = await db.tableNames();
    if (!names.includes(name)) {
      return null;
    }
    const table = await db.openTable(name);
    this.tables.set(name, table);
    return table;
  }

  async ensureTable(project: string, meta: TableMeta = { model: EMBEDDING_MODEL, dim: VECTOR_DIM }): Promise<void> {
    const name = this.tableName(project);
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes(name)) {
      // Table already exists, just cache and return
      if (!this.tables.has(name)) {
        const table = await db.openTable(name);
        this.tables.set(name, table);
      }
      return;
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
    this.tables.set(name, table);
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
  }

  /** Delete N sources then insert all chunks in ONE add() call — 1 fragment per wave. */
  async batchReplace(project: string, sources: string[], chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getTable(project);
    if (!table) {
      throw new Error(`Table for project '${project}' does not exist. Call ensureTable first.`);
    }
    // Delete all sources in parallel (each delete is one SQL call)
    await Promise.all(
      sources.map((src) => table.delete(`source = '${src.replace(/'/g, "''")}'`))
    );
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
  }

  async search(project: string, vector: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      const count = await table.countRows();
      if (count === 0) {
        return [];
      }
      const results = await table.vectorSearch(vector).limit(topK).toArray();
      return results.map((r) => ({
        id: r.id as string,
        content: r.content as string,
        source: r.source as string,
        module: r.module as string,
        score: 1 / (1 + (r._distance as number)),
      }));
    } catch {
      return [];
    }
  }

  async deleteBySource(project: string, source: string): Promise<void> {
    const table = await this.getTable(project);
    if (!table) {
      return;
    }
    await table.delete(`source = '${source.replace(/'/g, "''")}'`);
  }

  async listModules(project: string): Promise<string[]> {
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      const count = await table.countRows();
      if (count === 0) return [];
      const rows = await table.query().select(["module"]).toArray();
      const modules = [...new Set(rows.map((r) => r.module as string))];
      return modules.sort();
    } catch {
      return [];
    }
  }

  async getModuleChunks(project: string, module: string): Promise<Chunk[]> {
    const table = await this.getTable(project);
    if (!table) {
      return [];
    }
    try {
      const count = await table.countRows();
      if (count === 0) return [];
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
        symbol_kind: r.symbol_kind as string | undefined,
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
      return chunks.sort((a, b) => a.source.localeCompare(b.source));
    } catch {
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

  async optimize(project: string): Promise<void> {
    const table = await this.getTable(project);
    if (!table) return;
    try {
      await Promise.race([
        (table as any).optimize(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
      ]);
    } catch {
      // optimize() may not be available or may timeout — non-fatal
    }
  }

  async buildIndexes(project: string): Promise<void> {
    const table = await this.getTable(project);
    if (!table) return;
    try {
      await table.createIndex("content", { config: Index.fts() });
    } catch {
      // Index may already exist or table has too few rows — non-fatal
    }
  }

  async hybridSearch(project: string, vector: number[], text: string, topK: number): Promise<SearchResult[]> {
    const table = await this.getTable(project);
    if (!table) return [];
    try {
      if ((await table.countRows()) === 0) return [];
      const reranker = await rerankers.RRFReranker.create();
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
        symbol_kind: r.symbol_kind as string | undefined,
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      }));
    } catch {
      // FTS index may be missing on tiny tables — fall back to pure vector search
      return this.search(project, vector, topK);
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
        symbol_kind: r.symbol_kind as string | undefined,
        signature: r.signature as string | undefined,
        start_line: r.start_line as number | undefined,
        end_line: r.end_line as number | undefined,
      };
    } catch { return null; }
  }
}
