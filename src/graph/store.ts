import { Database } from "bun:sqlite";

export interface EdgeInput { dst_name: string; edge_type: string; }
export interface SymbolInput {
  name: string; kind: string; signature: string;
  start_line: number; end_line: number; edges: EdgeInput[];
}
export interface SymbolHit { name: string; kind: string; signature: string; path: string; start_line: number; end_line: number; }
export interface RankedSymbol {
  id: number; name: string; kind: string; signature: string;
  file: string; start_line: number; end_line: number; rank: number;
}

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

  /** Total number of indexed symbols across all files. */
  countSymbols(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
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
   * Batch variant of resolveEdgesForFile: resolves cross-file call edges for
   * MULTIPLE files inside a single SQLite transaction, instead of one
   * autocommit pair of UPDATEs per file. Same per-file resolution logic
   * (reused via resolveEdgesForFile), just wrapped once — mirrors how
   * replaceFile() wraps its per-file work in this.db.transaction().
   */
  resolveEdgesForFiles(paths: string[]): void {
    const tx = this.db.transaction(() => {
      for (const path of paths) this.resolveEdgesForFile(path);
    });
    tx();
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

  /**
   * Shortest caller→callee path between two symbol names (BFS via recursive
   * CTE, same cycle guard as impact). Returns ordered SymbolHits including
   * both endpoints; [] when unreachable within maxDepth. Same-name ambiguity:
   * every definition of `from` seeds the walk; the shortest path wins.
   */
  tracePath(from: string, to: string, maxDepth = 8): SymbolHit[] {
    if (from === to) {
      const self = this.findSymbol(from);
      return self.length ? [self[0]] : [];
    }
    const row = this.db.query(
      `WITH RECURSIVE walk(id, depth, path) AS (
         SELECT s.id, 0, '/' || s.id || '/' FROM symbols s WHERE s.name = $from
         UNION
         SELECT e.dst_symbol_id, walk.depth + 1, walk.path || e.dst_symbol_id || '/'
         FROM edges e JOIN walk ON e.src_symbol_id = walk.id
         WHERE e.dst_symbol_id IS NOT NULL
           AND walk.depth < $d
           AND walk.path NOT LIKE '%/' || e.dst_symbol_id || '/%'
       )
       SELECT walk.path AS path FROM walk
       JOIN symbols s ON s.id = walk.id
       WHERE s.name = $to
       ORDER BY walk.depth LIMIT 1`
    ).get({ $from: from, $to: to, $d: maxDepth }) as { path: string } | null;
    if (!row) return [];
    const ids = row.path.split("/").filter(Boolean).map(Number);
    // Hydrate in path order (one query, reorder in JS — ids are few).
    const placeholders = ids.map(() => "?").join(",");
    const hits = this.db.query(
      `SELECT s.id AS id, ${this.hitSql} FROM symbols s JOIN files f ON s.file_id=f.id WHERE s.id IN (${placeholders})`
    ).all(...ids) as (SymbolHit & { id: number })[];
    const byId = new Map(hits.map((h) => [h.id, h]));
    return ids.map((id) => byId.get(id)!).filter(Boolean).map(({ id: _id, ...hit }) => hit as SymbolHit);
  }

  /**
   * PageRank over the resolved symbol-call graph (nodes = symbols, edges =
   * resolved edges.dst_symbol_id). Aider-style repo map ranking, but at
   * symbol granularity rather than file granularity.
   *
   * - Loads all symbols + all resolved edges (src_symbol_id AND dst_symbol_id
   *   both non-null) into memory, then iterates plain-JS power iteration.
   * - Multi-edges (same src→dst called more than once) are deduped to a
   *   single edge — simpler than weighting, and call *count* between two
   *   symbols isn't a meaningfully stronger importance signal here.
   * - Dangling nodes (zero outgoing resolved edges) redistribute their rank
   *   mass uniformly across ALL nodes each iteration (standard PageRank sink
   *   handling) so total rank mass is conserved instead of leaking.
   * - `focus`: when given and at least one name matches an existing symbol,
   *   runs personalized PageRank — the teleport/reset vector concentrates
   *   uniformly on the matching symbols instead of uniformly on all nodes.
   *   If no name matches, silently falls back to standard uniform teleport.
   * - Converges early once the L1 delta between iterations drops below 1e-6,
   *   even if under `iterations`.
   * - Empty graph → [].
   */
  pageRank(opts?: { damping?: number; iterations?: number; focus?: string[] }): RankedSymbol[] {
    const damping = opts?.damping ?? 0.85;
    const maxIterations = opts?.iterations ?? 20;

    const symbols = this.db.query(
      `SELECT s.id AS id, ${this.hitSql} FROM symbols s JOIN files f ON s.file_id=f.id`
    ).all() as (SymbolHit & { id: number })[];
    if (symbols.length === 0) return [];

    const n = symbols.length;
    const indexById = new Map<number, number>();
    symbols.forEach((s, i) => indexById.set(s.id, i));

    const edgeRows = this.db.query(
      "SELECT DISTINCT src_symbol_id AS src, dst_symbol_id AS dst FROM edges WHERE src_symbol_id IS NOT NULL AND dst_symbol_id IS NOT NULL"
    ).all() as { src: number; dst: number }[];

    // Adjacency by index: out[i] = list of target indices reachable from i.
    const out: number[][] = Array.from({ length: n }, () => []);
    for (const e of edgeRows) {
      const si = indexById.get(e.src);
      const di = indexById.get(e.dst);
      if (si === undefined || di === undefined) continue;
      out[si].push(di);
    }
    const outDegree = out.map((o) => o.length);

    // Teleport/reset vector: uniform over all nodes, unless a valid focus is given.
    let teleport = new Array(n).fill(1 / n);
    if (opts?.focus && opts.focus.length > 0) {
      const focusSet = new Set(opts.focus);
      const focusIdx = symbols
        .map((s, i) => (focusSet.has(s.name) ? i : -1))
        .filter((i) => i >= 0);
      if (focusIdx.length > 0) {
        teleport = new Array(n).fill(0);
        for (const i of focusIdx) teleport[i] = 1 / focusIdx.length;
      }
      // else: no match — keep uniform teleport (silent fallback).
    }

    let rank = new Array(n).fill(1 / n);
    for (let iter = 0; iter < maxIterations; iter++) {
      const next = new Array(n).fill(0);

      // Dangling mass: sum of rank held by nodes with no outgoing edges,
      // redistributed uniformly across ALL nodes (standard sink handling).
      let danglingMass = 0;
      for (let i = 0; i < n; i++) if (outDegree[i] === 0) danglingMass += rank[i];

      for (let i = 0; i < n; i++) {
        if (outDegree[i] === 0) continue;
        const share = rank[i] / outDegree[i];
        for (const j of out[i]) next[j] += share;
      }

      let delta = 0;
      for (let i = 0; i < n; i++) {
        const teleported = (1 - damping) * teleport[i] + damping * (next[i] + danglingMass * teleport[i]);
        delta += Math.abs(teleported - rank[i]);
        next[i] = teleported;
      }
      rank = next;
      if (delta < 1e-6) break;
    }

    return symbols
      .map((s, i) => ({
        id: s.id, name: s.name, kind: s.kind, signature: s.signature,
        file: s.path, start_line: s.start_line, end_line: s.end_line, rank: rank[i],
      }))
      .sort((a, b) => b.rank - a.rank);
  }
}
