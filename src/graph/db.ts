import { Database } from "bun:sqlite";
// Embed the schema as text so it survives `bun build --compile`: readFileSync against
// import.meta.dir would hit a non-existent /$bunfs path in the shipped binary (ENOENT).
import SCHEMA from "./schema.sql" with { type: "text" };

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
