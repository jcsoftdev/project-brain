import { Database } from "bun:sqlite";

export interface EdgeInput { dst_name: string; edge_type: string; }
export interface SymbolInput {
  name: string; kind: string; signature: string;
  start_line: number; end_line: number; edges: EdgeInput[];
}
export interface SymbolHit { name: string; kind: string; signature: string; path: string; start_line: number; end_line: number; }

export class GraphStore {
  private delStmt: ReturnType<Database["query"]>;
  private insSymStmt: ReturnType<Database["query"]>;
  private insEdgeStmt: ReturnType<Database["query"]>;
  private hitSql = `s.name AS name, s.kind AS kind, s.signature AS signature,
                    f.path AS path, s.start_line AS start_line, s.end_line AS end_line`;

  constructor(private db: Database) {
    this.delStmt = this.db.query("DELETE FROM files WHERE path = $path");
    this.insSymStmt = this.db.query(
      "INSERT INTO symbols (file_id,name,kind,signature,start_line,end_line) VALUES ($f,$n,$k,$s,$a,$b) RETURNING id"
    );
    this.insEdgeStmt = this.db.query(
      "INSERT INTO edges (src_symbol_id,dst_name,dst_symbol_id,edge_type) VALUES ($s,$d,NULL,$t)"
    );
  }

  /** Close the underlying SQLite connection. Callers that own the connection use this on shutdown. */
  close(): void {
    this.db.close();
  }

  deleteFile(path: string): void {
    // ON DELETE CASCADE removes symbols + edges
    this.delStmt.run({ $path: path });
  }

  replaceFile(path: string, lang: string, hash: string, mtime: number, symbols: SymbolInput[]): void {
    const tx = this.db.transaction(() => {
      this.deleteFile(path);
      const fileId = (this.db.query(
        "INSERT INTO files (path, lang, hash, mtime) VALUES ($p,$l,$h,$m) RETURNING id"
      ).get({ $p: path, $l: lang, $h: hash, $m: mtime }) as { id: number }).id;

      for (const sym of symbols) {
        const symId = (this.insSymStmt.get({
          $f: fileId, $n: sym.name, $k: sym.kind, $s: sym.signature, $a: sym.start_line, $b: sym.end_line,
        }) as { id: number }).id;
        for (const e of sym.edges) this.insEdgeStmt.run({ $s: symId, $d: e.dst_name, $t: e.edge_type });
      }
    });
    tx();
  }

  resolveEdgesForFile(path: string): void {
    // edges originating in this file → prefer a same-file symbol match first
    // (a local call is far more likely to target a same-file definition than
    // an arbitrary cross-repo namesake); fall back to the prior
    // arbitrary-match behavior when no same-file candidate exists. This is
    // the "scope-aware refinement" 2026-06-16-structural-layer-design.md §10
    // explicitly deferred as future work.
    this.db.query(`
      UPDATE edges SET dst_symbol_id = COALESCE(
        (SELECT s.id FROM symbols s
           WHERE s.name = edges.dst_name
             AND s.file_id = (SELECT file_id FROM symbols WHERE id = edges.src_symbol_id)
           LIMIT 1),
        (SELECT s.id FROM symbols s WHERE s.name = edges.dst_name LIMIT 1)
      )
      WHERE src_symbol_id IN (
        SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = $p
      )`).run({ $p: path });
    // edges anywhere whose target name was (re)defined in this file → (re)link,
    // same same-file-first preference.
    this.db.query(`
      UPDATE edges SET dst_symbol_id = COALESCE(
        (SELECT s.id FROM symbols s
           WHERE s.name = edges.dst_name
             AND s.file_id = (SELECT file_id FROM symbols WHERE id = edges.src_symbol_id)
           LIMIT 1),
        (SELECT s.id FROM symbols s WHERE s.name = edges.dst_name LIMIT 1)
      )
      WHERE dst_name IN (
        SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = $p
      )`).run({ $p: path });
  }

  /**
   * Repair edge → symbol links after deletions/renames.
   *
   * SQLite reuses rowids, so a deleted symbol's id can be reassigned to an
   * unrelated symbol. Edges that still carry the stale dst_symbol_id would then
   * make `impact` traverse the wrong (or deleted) symbol. This:
   *   1. NULLs every dst_symbol_id that no longer points at a live symbol, then
   *   2. re-links by name where a matching symbol still exists.
   */
  pruneDanglingEdges(): void {
    this.db.query(`
      UPDATE edges SET dst_symbol_id = NULL
      WHERE dst_symbol_id IS NOT NULL
        AND dst_symbol_id NOT IN (SELECT id FROM symbols)`).run();
    this.db.query(`
      UPDATE edges SET dst_symbol_id = COALESCE(
        (SELECT s.id FROM symbols s
           WHERE s.name = edges.dst_name
             AND s.file_id = (SELECT file_id FROM symbols WHERE id = edges.src_symbol_id)
           LIMIT 1),
        (SELECT s.id FROM symbols s WHERE s.name = edges.dst_name LIMIT 1)
      )
      WHERE dst_symbol_id IS NULL`).run();
  }

  findSymbol(name: string) {
    return this.db.query(
      `SELECT ${this.hitSql} FROM symbols s JOIN files f ON s.file_id=f.id WHERE s.name = $n`
    ).all({ $n: name }) as SymbolHit[];
  }

  findCallers(name: string) {
    return this.db.query(
      `SELECT DISTINCT ${this.hitSql} FROM edges e
       JOIN symbols s ON e.src_symbol_id = s.id JOIN files f ON s.file_id=f.id
       WHERE e.dst_name = $n`
    ).all({ $n: name }) as SymbolHit[];
  }

  findCallees(name: string) {
    return this.db.query(
      `SELECT DISTINCT ${this.hitSql} FROM edges e
       JOIN symbols src ON e.src_symbol_id = src.id
       JOIN symbols s ON s.name = e.dst_name JOIN files f ON s.file_id=f.id
       WHERE src.name = $n`
    ).all({ $n: name }) as SymbolHit[];
  }

  impact(name: string, maxDepth = 6) {
    return this.db.query(
      `WITH RECURSIVE up(id, depth, path) AS (
         SELECT s.id, 0, '/' || s.id || '/' FROM symbols s WHERE s.name = $n
         UNION
         SELECT e.src_symbol_id, up.depth + 1, up.path || e.src_symbol_id || '/'
         FROM edges e JOIN up ON e.dst_symbol_id = up.id
         WHERE up.depth < $d
           AND up.path NOT LIKE '%/' || e.src_symbol_id || '/%'
       )
       SELECT DISTINCT ${this.hitSql}
       FROM up JOIN symbols s ON s.id = up.id JOIN files f ON s.file_id=f.id
       WHERE up.depth > 0`
    ).all({ $n: name, $d: maxDepth }) as SymbolHit[];
  }
}
