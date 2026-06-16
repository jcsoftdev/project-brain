import { Parser, Language } from "web-tree-sitter";
import { langForExt } from "./languages";
import { MAX_PARSE_BYTES, MAX_LINE_LENGTH, PARSER_TEARDOWN_EVERY } from "../constants";

export interface ParsedTree { tree: any; langId: string; }

export class WasmParser {
  private parser: any = null;
  private grammars = new Map<string, any>();
  private sinceTeardown = 0;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    this.parser = new Parser();
    this.initialized = true;
  }

  private oversize(source: string): boolean {
    if (Buffer.byteLength(source, "utf8") > MAX_PARSE_BYTES) return true;
    for (const line of source.split("\n")) if (line.length > MAX_LINE_LENGTH) return true;
    return false;
  }

  private async ensureGrammar(langId: string, wasmPath: string): Promise<any> {
    let g = this.grammars.get(langId);
    if (!g) { g = await Language.load(wasmPath); this.grammars.set(langId, g); }  // lazy per-language
    return g;
  }

  // NOTE: grammar load is async; callers preload via warm() or accept first-call cost.
  parseFile(ext: string, source: string): ParsedTree | null {
    const spec = langForExt(ext);
    if (!spec) return null;
    if (this.oversize(source)) return null;
    const grammar = this.grammars.get(spec.id);
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
    if (spec) await this.ensureGrammar(spec.id, spec.wasmPath);
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
    for (const lang of this.grammars.values()) {
      if (typeof lang?.delete === "function") lang.delete();
    }
    this.grammars.clear();
  }
}
