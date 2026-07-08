import { Parser, Language } from "web-tree-sitter";
// Core runtime wasm, embedded into the compiled binary via `{ type: "file" }`
// (bun --compile bakes it in → /$bunfs path at runtime). Without locateFile pointing
// here, Parser.init() reads from CWD and crashes in the shipped binary with
// `ENOENT '/$bunfs/root/tree-sitter.wasm'`. See structural-layer/publish-blocker-wasm.
import coreWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import { langForExt } from "./languages";
import { MAX_PARSE_BYTES, MAX_LINE_LENGTH, PARSER_TEARDOWN_EVERY } from "../constants";

export interface ParsedTree { tree: any; langId: string; }

export class WasmParser {
  private parser: any = null;
  /** In-flight load promises — deduplicates concurrent Language.load calls for the same langId. */
  private grammars = new Map<string, Promise<any>>();
  /** Resolved grammars — populated after warm(); used by the sync parseFile path. */
  private ready = new Map<string, any>();
  private sinceTeardown = 0;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init({ locateFile: () => coreWasm } as any);
    this.parser = new Parser();
    this.initialized = true;
  }

  private oversize(source: string): boolean {
    if (Buffer.byteLength(source, "utf8") > MAX_PARSE_BYTES) return true;
    // Manual newline scan instead of source.split("\n") — avoids materializing
    // an array of every line just to find one that's too long.
    let lineStart = 0;
    for (let i = 0; i <= source.length; i++) {
      if (i === source.length || source.charCodeAt(i) === 10 /* "\n" */) {
        if (i - lineStart > MAX_LINE_LENGTH) return true;
        lineStart = i + 1;
      }
    }
    return false;
  }

  private async ensureGrammar(langId: string, wasmPath: string): Promise<any> {
    let p = this.grammars.get(langId);
    if (!p) {
      // Evict on rejection so a transient/failed Language.load does NOT poison
      // the cache permanently. A second attempt can retry; until then parseFile
      // simply returns null for this language (grammar not ready).
      p = Language.load(wasmPath).catch((err) => {
        this.grammars.delete(langId);
        throw err;
      });
      this.grammars.set(langId, p);
    }
    return p;
  }

  // NOTE: grammar load is async; callers preload via warm() or accept first-call cost.
  parseFile(ext: string, source: string): ParsedTree | null {
    const spec = langForExt(ext);
    if (!spec) return null;
    if (this.oversize(source)) return null;
    const grammar = this.ready.get(spec.id);
    if (!grammar) return null; // must warm(ext) first; keeps parseFile sync + one-tree-at-a-time
    this.maybeTeardown();
    this.parser.setLanguage(grammar);
    const tree = this.parser.parse(source);
    if (!tree) return null;
    this.sinceTeardown++;
    return { tree, langId: spec.id };
  }

  async warm(ext: string): Promise<void> {
    const spec = langForExt(ext);
    if (!spec) return;
    // Never throw: a failed grammar load leaves the language unsupported
    // (parseFile returns null when not in `ready`) but keeps the parser usable
    // for other languages. The rejected promise is evicted in ensureGrammar.
    try {
      const grammar = await this.ensureGrammar(spec.id, spec.wasmPath);
      this.ready.set(spec.id, grammar);
    } catch (err) {
      console.warn(`[parser] grammar load failed for ${spec.id}:`, err instanceof Error ? err.message : err);
    }
  }

  private maybeTeardown(): void {
    if (this.sinceTeardown >= PARSER_TEARDOWN_EVERY) {
      this.parser.delete();
      this.parser = new Parser();   // reclaim WASM linear memory high-water
      this.sinceTeardown = 0;
    }
  }

  dispose(): void {
    if (this.parser) this.parser.delete();
    this.parser = null;
    for (const lang of this.ready.values()) {
      if (typeof lang?.delete === "function") lang.delete();
    }
    this.grammars.clear();
    this.ready.clear();
  }
}
