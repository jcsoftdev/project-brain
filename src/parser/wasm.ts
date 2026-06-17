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
    for (const line of source.split("\n")) if (line.length > MAX_LINE_LENGTH) return true;
    return false;
  }

  private async ensureGrammar(langId: string, wasmPath: string): Promise<any> {
    let p = this.grammars.get(langId);
    if (!p) { p = Language.load(wasmPath); this.grammars.set(langId, p); }
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
    if (spec) {
      const grammar = await this.ensureGrammar(spec.id, spec.wasmPath);
      this.ready.set(spec.id, grammar);
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
