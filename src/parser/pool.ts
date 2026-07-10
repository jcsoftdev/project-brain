// src/parser/pool.ts
// Bounded worker-pool parallel WASM parse — the "Future (phase 2)" deferred
// in docs/superpowers/specs/2026-06-16-structural-layer-design.md §12. Each
// worker (src/parser/worker.ts) owns its own memory-bounded WasmParser;
// nothing is shared across threads. Spawned per reindex run, terminated
// after — never resident in the long-lived `serve` process.
import type { SymbolInput } from "../graph/store.js";
import type { Boundary } from "./extract.js";
import type { ParseRequest, ParseResponse } from "./worker.js";

// Worker script URL, resolved relative to THIS module (import.meta.url), so it
// is CWD-independent in every context. It deliberately does NOT use a
// `with { type: "file" }` import: that embeds only the RAW worker.ts source
// (untranspiled, and WITHOUT its transitive graph — wasm.ts, extract.ts,
// languages.ts — nor the nested `{ type: "file" }` grammar/core WASM assets
// those modules pull in), so in a `bun build --compile` binary the spawned
// worker fails to resolve its own imports and structural extraction silently
// yields zero symbols.
//
// The working combination (empirically verified against Bun 1.3.14, this
// project's `bun test` runner, and actual `bun build --compile` output) is:
//
//   1. Compile the worker as a SECOND entrypoint so Bun bundles its FULL
//      graph + nested WASM assets into the one binary:
//        bun build ./src/cli.ts ./src/parser/worker.ts --compile --outfile ...
//      (see package.json `build` and .github/workflows/release.yml).
//   2. Reference the bundled worker by the path it lands at.
//
// Path differs by context because multi-entrypoint `--compile` flattens
// entrypoints by their COMMON BASE (here `src/`):
//   - Dev (`bun test`/`bun run`): worker.ts is a sibling of this file, and
//     import.meta.url is this module's real path → "./worker.js" (Bun resolves
//     the .js specifier to worker.ts).
//   - Compiled binary: worker.ts lands at `<bunfs>/parser/worker.js` while a
//     bundled pool.ts's import.meta.url is the binary root
//     (`file:///$bunfs/root/<binary>`) → "./parser/worker.js".
//
// WINDOWS FINDING (release blocker, v0.7.0 — 3 failed releases on
// windows-x64 AND windows-arm64):
//
//   worker error: BuildMessage: ModuleNotFound resolving
//   "B:\~BUN\root\worker.js" (entry point)
//
// The original detection required POSIX slashes around the marker
// (`/$bunfs/` or `/~BUN/`). On Windows, Bun mounts the embedded FS at
// `B:\~BUN\...` — backslash-separated, so neither `/$bunfs/` nor `/~BUN/`
// ever matched. IS_COMPILED came out false, the dev sibling path
// ("./worker.js") was chosen, and it resolved to the nonexistent
// `B:\~BUN\root\worker.js` instead of the real bundled location
// `B:\~BUN\root\parser\worker.js`.
//
// Empirically verified (Bun 1.3.14, this repo, 2026-07):
//   - `new URL("./worker.js", base)` works correctly for well-formed
//     `file://` bases, INCLUDING `file:///B:/~BUN/root/cli.exe` (forward
//     slashes) — resolves to `file:///B:/~BUN/root/worker.js` as expected.
//   - A raw Windows path used directly as a URL base (e.g.
//     `B:\~BUN\root\cli.exe`, no `file://` prefix) does NOT behave like a
//     file path under the WHATWG URL parser: `new URL(base)` alone parses
//     it as a special URL with scheme `b:` (lowercased) and treats
//     everything after the first `\` as opaque path — passing that base to
//     `new URL("./worker.js", base)` throws
//     ("./worker.js" cannot be parsed as a URL). This shape must be
//     resolved via plain string manipulation instead of the URL API.
//   - A `file://` base with `%5C`-encoded backslashes (e.g.
//     `file:///B:%5C~BUN%5Croot%5Ccli.exe`) parses as a URL without
//     throwing, but `new URL("./worker.js", base)` collapses the whole
//     percent-encoded path to `file:///worker.js` — because there is no
//     literal `/` for the URL parser to split the last path segment on.
//     Detection still fires correctly here (the literal substring "~BUN"
//     survives percent-encoding), but resolution falls back to best-effort
//     string join rather than `new URL`.
//
// Detection is therefore separator- and encoding-agnostic: compiled if the
// url contains "$bunfs" OR "~BUN" anywhere, with no surrounding-slash
// requirement. "~BUN" itself is fixed-case in Bun's own source as of
// 1.3.14; this has NOT been verified against other Bun versions or against
// a genuine Windows compiled binary (no Windows machine available in this
// environment) — validated indirectly via `workflow_dispatch` on the
// release workflow instead. If Bun ever lowercases the drive letter or the
// marker itself in some future version, this detection would need
// case-insensitive matching; kept case-sensitive for now since that's what
// was empirically observed and documented above.
export function resolveWorkerEntry(importMetaUrl: string): string {
  const isCompiled =
    importMetaUrl.includes("$bunfs") || importMetaUrl.includes("~BUN");
  const relPath = isCompiled ? "parser/worker.js" : "worker.js";

  // Well-formed file:// (or other) URL bases resolve correctly with the URL
  // API — this covers dev, POSIX compiled, the Windows URL-form
  // (file:///B:/~BUN/...), and best-effort for the URL-encoded form.
  try {
    return new URL(`./${relPath}`, importMetaUrl).href;
  } catch {
    // Raw Windows path shapes (e.g. "B:\~BUN\root\cli.exe") are not
    // well-formed file:// URLs and throw out of `new URL`. Fall back to
    // string manipulation, preserving the original backslash separator
    // style: replace the last path segment (after the final backslash)
    // with the resolved relative path, also backslash-joined.
    const lastSep = importMetaUrl.lastIndexOf("\\");
    const dir = lastSep === -1 ? "" : importMetaUrl.slice(0, lastSep + 1);
    return dir + relPath.replace(/\//g, "\\");
  }
}

const workerPath = resolveWorkerEntry(import.meta.url);

export interface ParseJob {
  path: string;
  content: string;
  ext: string;
}

export interface ParseResult {
  path: string;
  langId: string;
  symbols: SymbolInput[];
  boundaries: Boundary[];
  error?: string;
}

/**
 * Below this file count, worker-thread startup overhead outweighs the
 * parallelism gain — callers should use the existing sequential WasmParser
 * path instead of constructing a ParserPool.
 */
export const POOL_MIN_FILES = 24;

interface QueuedJob {
  job: ParseJob;
  resolve: (r: ParseResult) => void;
}

export class ParserPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: QueuedJob[] = [];
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (r: ParseResult) => void; path: string; worker: Worker }
  >();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath);
      worker.onmessage = (event: MessageEvent<ParseResponse>) => {
        const res = event.data;
        const entry = this.pending.get(res.id);
        if (!entry) return;
        this.pending.delete(res.id);
        if ("error" in res) {
          entry.resolve({ path: res.path, langId: "", symbols: [], boundaries: [], error: res.error });
        } else {
          entry.resolve({ path: res.path, langId: res.langId, symbols: res.symbols, boundaries: res.boundaries });
        }
        this.idle.push(worker);
        this.drainQueue();
      };
      worker.onerror = (event: ErrorEvent) => {
        console.error(
          `[project-brain] worker error: ${event.message || String(event.error || "unknown worker error")}`,
        );
        // A worker that errors out (e.g. its module failed to load) will
        // never post the responses its currently-pending jobs are waiting
        // on, so those jobs' promises would hang forever. Settle every
        // pending job assigned to THIS worker with a failed result instead
        // of leaving them unresolved.
        for (const [id, entry] of this.pending) {
          if (entry.worker !== worker) continue;
          entry.resolve({
            path: entry.path,
            langId: "",
            symbols: [],
            boundaries: [],
            error: `worker error: ${event.message || String(event.error || "unknown worker error")}`,
          });
          this.pending.delete(id);
        }
        // Do not return this worker to the idle pool — it's broken.
        this.workers = this.workers.filter((w) => w !== worker);
        this.drainQueue();
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  private drainQueue(): void {
    // If every worker has died (e.g. all failed to load), no idle worker
    // will ever become available again — settle any still-queued jobs as
    // failures now instead of leaving their promises pending forever.
    if (this.workers.length === 0 && this.queue.length > 0) {
      const stranded = this.queue.splice(0, this.queue.length);
      for (const { job, resolve } of stranded) {
        resolve({ path: job.path, langId: "", symbols: [], boundaries: [], error: "worker pool has no live workers" });
      }
      return;
    }
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const { job, resolve } = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { resolve, path: job.path, worker });
      const req: ParseRequest = { id, path: job.path, content: job.content, ext: job.ext };
      worker.postMessage(req);
    }
  }

  parseOne(job: ParseJob): Promise<ParseResult> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.drainQueue();
    });
  }

  async parseMany(jobs: ParseJob[]): Promise<ParseResult[]> {
    return Promise.all(jobs.map((job) => this.parseOne(job)));
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
