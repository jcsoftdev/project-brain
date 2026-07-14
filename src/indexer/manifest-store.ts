import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, ManifestEntry } from "../commands/sync.js";
// Embed the schema as text so it survives `bun build --compile`: readFileSync
// against import.meta.dir would hit a non-existent /$bunfs path in the shipped
// binary (ENOENT) — mirrors the pattern already used by src/graph/db.ts.
import SCHEMA from "./manifest-schema.sql" with { type: "text" };

/**
 * SQLite-backed replacement for the hashes.json manifest. JSON forced a
 * full parse + full rewrite of EVERY file's state on EVERY sync — O(repo)
 * memory and I/O, and a crash mid-write corrupts all files' state at once.
 * Here reads are point lookups and writes are per-file transactions.
 */
export class ManifestStore {
  private db: Database;
  private getFileStmt: ReturnType<Database["query"]>;
  private getChunksStmt: ReturnType<Database["query"]>;
  private upsertFileStmt: ReturnType<Database["query"]>;
  private deleteChunksStmt: ReturnType<Database["query"]>;
  private insChunkStmt: ReturnType<Database["query"]>;
  private delFileStmt: ReturnType<Database["query"]>;
  private listStmt: ReturnType<Database["query"]>;

  constructor(root: string) {
    const dir = join(root, ".project-brain");
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "manifest.db"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(SCHEMA);

    this.getFileStmt = this.db.query("SELECT hash, mtime FROM manifest_files WHERE path = $p");
    this.getChunksStmt = this.db.query("SELECT chunk_id, content_hash FROM manifest_chunks WHERE file_path = $p");
    this.upsertFileStmt = this.db.query(
      "INSERT INTO manifest_files (path, hash, mtime) VALUES ($p, $h, $m) ON CONFLICT(path) DO UPDATE SET hash = $h, mtime = $m"
    );
    this.deleteChunksStmt = this.db.query("DELETE FROM manifest_chunks WHERE file_path = $p");
    this.insChunkStmt = this.db.query(
      "INSERT INTO manifest_chunks (file_path, chunk_id, content_hash) VALUES ($p, $c, $h)"
    );
    this.delFileStmt = this.db.query("DELETE FROM manifest_files WHERE path = $p");
    this.listStmt = this.db.query("SELECT path FROM manifest_files ORDER BY path");

    this.migrateJsonIfPresent(dir);
  }

  /**
   * One-time import of a legacy hashes.json (both entry shapes — bare hash
   * string, or the full {hash,mtime,chunks} object), then rename it to .bak
   * so re-opening this store never re-migrates. Unreadable/corrupt legacy
   * JSON is swallowed (worst case: a full re-sync, not a crash). A TOCTOU
   * race between two processes migrating the same root can make the final
   * renameSync throw (ENOENT — the other process already renamed it); that
   * throw is swallowed too since the data was already committed either way.
   */
  private migrateJsonIfPresent(dir: string): void {
    const jsonPath = join(dir, "hashes.json");
    if (!existsSync(jsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, string | ManifestEntry>;
      const tx = this.db.transaction(() => {
        for (const [path, v] of Object.entries(parsed)) {
          const entry: ManifestEntry = typeof v === "string" ? { hash: v, mtime: 0 } : v;
          this.upsertFile(path, entry.hash, entry.mtime, entry.chunks ?? {});
        }
      });
      tx();
      renameSync(jsonPath, jsonPath + ".bak");
    } catch {
      // Unreadable legacy manifest, or a racing process already renamed it
      // out from under us — either way, non-fatal.
    }
  }

  getEntry(path: string): (ManifestEntry & { chunks: Record<string, string> }) | null {
    const file = this.getFileStmt.get({ $p: path }) as { hash: string; mtime: number } | null;
    if (!file) return null;
    const chunks: Record<string, string> = {};
    for (const row of this.getChunksStmt.all({ $p: path }) as Array<{ chunk_id: string; content_hash: string }>) {
      chunks[row.chunk_id] = row.content_hash;
    }
    return { hash: file.hash, mtime: file.mtime, chunks };
  }

  upsertFile(path: string, hash: string, mtime: number, chunks: Record<string, string>): void {
    const tx = this.db.transaction(() => {
      this.upsertFileStmt.run({ $p: path, $h: hash, $m: mtime });
      this.deleteChunksStmt.run({ $p: path });
      for (const [chunkId, contentHash] of Object.entries(chunks)) {
        this.insChunkStmt.run({ $p: path, $c: chunkId, $h: contentHash });
      }
    });
    tx();
  }

  deleteFile(path: string): void {
    this.delFileStmt.run({ $p: path }); // chunks cascade via ON DELETE CASCADE
  }

  listPaths(): string[] {
    return (this.listStmt.all() as Array<{ path: string }>).map((r) => r.path);
  }

  clear(): void {
    this.db.run("DELETE FROM manifest_files"); // chunks cascade
  }

  close(): void {
    this.db.close();
  }
}

export type { Manifest, ManifestEntry };
