/**
 * Hidden build-smoke hook: `project-brain __parse-selftest <file>`.
 *
 * Purpose: prove the cross-compiled (`bun build --compile`) binary actually
 * loaded the embedded tree-sitter core + a grammar and produced symbols —
 * WITHOUT touching Ollama, the vector store, or SQLite. The release workflow
 * runs this against the native binary so a broken embedded WASM asset FAILS
 * loudly instead of degrading to "zero symbols" (which the negative grep alone
 * cannot detect).
 *
 * Output contract (parsed by .github/workflows/release.yml):
 *   - On success: prints `STRUCT_OK <symbolCount>` (count >= 1) and exits 0.
 *   - On any failure (parser init, grammar load, zero symbols, read error):
 *     prints a diagnostic to stderr and exits 1.
 *
 * This is intentionally minimal — no embeddings, no store, no graph DB.
 */
import { extract } from "../parser/extract.js";

/** Run the parse self-test against a single source file. Returns symbol count. */
export async function runParseSelfTest(filePath: string): Promise<number> {
  const { WasmParser } = await import("../parser/wasm.js");
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const source = await Bun.file(filePath).text();

  const parser = new WasmParser();
  try {
    await parser.init();
    await parser.warm(ext);
    const parsed = parser.parseFile(ext, source);
    if (!parsed) return 0;
    try {
      const syms = extract(parsed.tree, parsed.langId, source);
      return syms.length;
    } finally {
      parsed.tree.delete();
    }
  } finally {
    parser.dispose();
  }
}

export async function execute(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("__parse-selftest: missing <file> argument");
    process.exit(1);
  }

  try {
    const count = await runParseSelfTest(filePath);
    if (count < 1) {
      console.error(`STRUCT_FAIL 0 — parser produced no symbols for ${filePath}`);
      process.exit(1);
    }
    console.log(`STRUCT_OK ${count}`);
    process.exit(0);
  } catch (err) {
    console.error(`STRUCT_FAIL — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
