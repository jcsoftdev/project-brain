-- src/indexer/manifest-schema.sql
CREATE TABLE IF NOT EXISTS manifest_files (
  path  TEXT PRIMARY KEY,
  hash  TEXT NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_chunks (
  file_path    TEXT NOT NULL REFERENCES manifest_files(path) ON DELETE CASCADE,
  chunk_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (file_path, chunk_id)
);
