export interface FileRow { id: number; path: string; lang: string; hash: string; mtime: number; }
export interface SymbolRow { id: number; file_id: number; name: string; kind: string; signature: string; start_line: number; end_line: number; }
export interface EdgeRow { id: number; src_symbol_id: number; dst_name: string; dst_symbol_id: number | null; edge_type: string; }
