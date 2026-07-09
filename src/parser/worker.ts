// src/parser/worker.ts
// Worker-thread entry point for parallel WASM parsing. Each worker owns its
// OWN WasmParser instance — WASM Parser/Language objects are not thread-safe
// or transferable, so nothing is ever shared across workers. Spawned and
// terminated by ParserPool (src/parser/pool.ts); never resident in the
// long-lived `serve` process — see docs/superpowers/specs/
// 2026-06-16-structural-layer-design.md §3.3 (heavy work stays ephemeral).
import { WasmParser } from "./wasm.js";
import { extract, extractBoundaries, type Boundary } from "./extract.js";
import type { SymbolInput } from "../graph/store.js";

export interface ParseRequest {
  id: number;
  path: string;
  content: string;
  ext: string;
}

export interface ParseSuccess {
  id: number;
  path: string;
  langId: string;
  symbols: SymbolInput[];
  /**
   * Serializable AST declaration boundaries (byte/line spans, no Node/Tree
   * references — tree-sitter Tree objects cannot cross the worker
   * postMessage boundary). Used by the cAST chunker to derive chunk
   * boundaries from real AST structure instead of regex/brace-counting.
   */
  boundaries: Boundary[];
}

export interface ParseFailure {
  id: number;
  path: string;
  error: string;
}

export type ParseResponse = ParseSuccess | ParseFailure;

const parser = new WasmParser();
const warmedExts = new Set<string>();
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = parser.init();
  await initPromise;
}

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, path, content, ext } = event.data;
  try {
    await ensureInit();
    if (!warmedExts.has(ext)) {
      await parser.warm(ext);
      warmedExts.add(ext);
    }
    const pt = parser.parseFile(ext, content);
    if (!pt) {
      // Unsupported extension or gated input (oversize / pathological line) —
      // not an error, just no structural data for this file.
      const success: ParseSuccess = { id, path, langId: "", symbols: [], boundaries: [] };
      postMessage(success);
      return;
    }
    try {
      const symbols = extract(pt.tree, pt.langId, content);
      const boundaries = extractBoundaries(pt.tree, pt.langId);
      const success: ParseSuccess = { id, path, langId: pt.langId, symbols, boundaries };
      postMessage(success);
    } finally {
      pt.tree.delete();
    }
  } catch (err) {
    const failure: ParseFailure = {
      id,
      path,
      error: err instanceof Error ? err.message : String(err),
    };
    postMessage(failure);
  }
};
