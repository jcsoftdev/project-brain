import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

export function openGraphDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA wal_autocheckpoint = 1000");
  db.run("PRAGMA cache_size = -8000");   // ~8MB page cache; tuned, not unbounded
  db.run("PRAGMA mmap_size = 134217728"); // 128MB mmap for fast reads
  db.run(SCHEMA);
  return db;
}
