import { Database } from "bun:sqlite";

export interface EdgeInput { dst_name: string; edge_type: string; }
export interface SymbolInput {
  name: string; kind: string; signature: string;
  start_line: number; end_line: number; edges: EdgeInput[];
}

export class GraphStore {
  private delStmt: ReturnType<Database["query"]>;

  constructor(private db: Database) {
    this.delStmt = this.db.query("DELETE FROM files WHERE path = $path");
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

      const insSym = this.db.query(
        "INSERT INTO symbols (file_id,name,kind,signature,start_line,end_line) VALUES ($f,$n,$k,$s,$a,$b) RETURNING id"
      );
      const insEdge = this.db.query(
        "INSERT INTO edges (src_symbol_id,dst_name,dst_symbol_id,edge_type) VALUES ($s,$d,NULL,$t)"
      );
      for (const sym of symbols) {
        const symId = (insSym.get({
          $f: fileId, $n: sym.name, $k: sym.kind, $s: sym.signature, $a: sym.start_line, $b: sym.end_line,
        }) as { id: number }).id;
        for (const e of sym.edges) insEdge.run({ $s: symId, $d: e.dst_name, $t: e.edge_type });
      }
    });
    tx();
  }
}
