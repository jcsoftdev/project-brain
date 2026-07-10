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
 * With `--pool`, it exercises the WORKER-POOL path (src/parser/pool.ts)
 * instead of the in-process sequential parser: it parses POOL_MIN_FILES+
 * synthetic sources through a real ParserPool. This proves the worker script
 * — bundled as a second `--compile` entrypoint with its full graph + embedded
 * WASM assets — actually loads and extracts symbols inside the shipped binary
 * (the single-file path above only covers the sequential parser).
 *
 * This is intentionally minimal — no embeddings, no store, no graph DB.
 */
import { extract } from "../parser/extract.js";
import { ParserPool, POOL_MIN_FILES, poolDiagnostics } from "../parser/pool.js";

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

/**
 * Run the parse self-test through the worker pool. Generates POOL_MIN_FILES + 2
 * synthetic TS sources (each with one known symbol) and parses them via a real
 * ParserPool, proving the compiled binary's embedded worker entrypoint loads
 * and extracts symbols. Returns the total symbol count across all files.
 *
 * On failure, the thrown Error's `cause` carries the pool's `attemptLog` (see
 * pool.ts's candidate-based resolver) so callers can print WHICH worker-entry
 * candidates were tried and how each failed — empirical diagnostics instead
 * of a bare error message, for the still-unexplained Windows worker-path
 * failure (see pool.ts's doc comment: byte-identical error survived the
 * separator-agnostic detection fix).
 */
export async function runPoolSelfTest(): Promise<number> {
  const count = POOL_MIN_FILES + 2;
  const jobs = Array.from({ length: count }, (_, i) => ({
    path: `selftest-${i}.ts`,
    content: `export function selftest${i}(a: number, b: number): number { return a + b; }\n`,
    ext: ".ts",
  }));

  const pool = new ParserPool(2);
  try {
    const results = await pool.parseMany(jobs);
    let total = 0;
    for (const r of results) {
      if (r.error) {
        throw new Error(`worker failed for ${r.path}: ${r.error}`, { cause: pool.attemptLog });
      }
      total += r.symbols.length;
    }
    return total;
  } catch (err) {
    if (err instanceof Error && err.cause === undefined) {
      throw new Error(err.message, { cause: pool.attemptLog });
    }
    throw err;
  } finally {
    pool.dispose();
  }
}

export async function execute(args: string[]): Promise<void> {
  if (args.includes("--pool")) {
    const { importMetaUrl, candidates } = poolDiagnostics();
    console.error(`DIAG: pool.ts import.meta.url = ${importMetaUrl}`);
    console.error(`DIAG: worker-entry candidates (in try order) = ${JSON.stringify(candidates)}`);
    try {
      const count = await runPoolSelfTest();
      if (count < 1) {
        console.error("STRUCT_FAIL 0 — worker pool produced no symbols");
        process.exit(1);
      }
      console.log(`STRUCT_OK ${count}`);
      process.exit(0);
    } catch (err) {
      const attemptLog =
        err instanceof Error && Array.isArray(err.cause) ? err.cause : undefined;
      if (attemptLog) {
        for (const attempt of attemptLog) {
          if (attempt.outcome === "errored" && attempt.message) {
            // Keep DIAG output single-line so a CI grep matching on the
            // `^DIAG:` prefix (see commit ab74b2d) can reliably match each
            // attempt as one line, even if the underlying worker error
            // message itself contains newlines.
            const singleLineMessage = attempt.message.replace(/\r?\n/g, " ");
            console.error(`DIAG: candidate tried = ${attempt.url} -> errored: ${singleLineMessage}`);
          } else if (attempt.outcome === "timed-out") {
            console.error(`DIAG: candidate tried = ${attempt.url} -> timed-out`);
          } else {
            console.error(`DIAG: candidate tried = ${attempt.url} -> ${attempt.outcome}`);
          }
        }
      } else {
        console.error("DIAG: no candidate attempt log available (failure occurred outside pool construction)");
      }
      console.error(`STRUCT_FAIL — ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

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
