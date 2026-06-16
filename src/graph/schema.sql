-- src/graph/schema.sql
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  src_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst_name TEXT NOT NULL,
  dst_symbol_id INTEGER,
  edge_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol ON edges(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_name ON edges(dst_name);
