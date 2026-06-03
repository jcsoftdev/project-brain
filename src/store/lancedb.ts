import * as lancedb from "@lancedb/lancedb";
import { TABLE_SUFFIX, VECTOR_DIM } from "../constants.js";
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

  async ensureTable(project: string): Promise<void> {
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
      vector: new Array(VECTOR_DIM).fill(0),
      content: "",
      source: "__seed__",
      module: "__seed__",
      content_hash: "",
      updated_at: 0,
    };
    const table = await db.createTable(name, [seed]);
    await table.delete("id = '__seed__'");
    this.tables.set(name, table);
  }

  async upsert(project: string, chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = await this.getTable(project);
    if (!table) {
      throw new Error(`Table for project '${project}' does not exist. Call ensureTable first.`);
    }
    // Single DELETE with IN clause (N deletes → 1)
    const ids = chunks.map((c) => `'${c.id.replace(/'/g, "''")}'`).join(", ");
    await table.delete(`id IN (${ids})`);
    const records = chunks.map((c) => ({
      id: c.id,
      vector: c.vector,
      content: c.content,
      source: c.source,
      module: c.module,
      content_hash: c.content_hash,
      updated_at: c.updated_at,
    }));
    await table.add(records);
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
}
