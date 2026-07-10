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
//     the .js specifier to worker.ts). This one IS certain — no ambiguity,
//     only one plausible layout in dev.
//   - Compiled binary: ORIGINALLY assumed worker.ts always lands at
//     `<bunfs>/parser/worker.js` (verified on macOS/Linux) while a bundled
//     pool.ts's import.meta.url is the binary root
//     (`file:///$bunfs/root/<binary>`) → "./parser/worker.js". WINDOWS
//     FINDING #2 below proved this is NOT universal — see that section for
//     why resolution is candidate-based instead of a single fixed path.
//
// WINDOWS FINDING #1 (release blocker, v0.7.0 — 3 failed releases on
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
// `B:\~BUN\root\worker.js` instead of the (assumed) bundled location
// `B:\~BUN\root\parser\worker.js`. Fixed in 4d9e00b by making detection
// separator/encoding-agnostic (substring match on "$bunfs"/"~BUN", no
// surrounding-slash requirement).
//
// WINDOWS FINDING #2 (STILL FAILING after #1, workflow_dispatch @ 2661f73,
// real windows-x64/arm64 runners, tag-free run):
//
//   worker error: BuildMessage: ModuleNotFound resolving
//   "B:\~BUN\root\worker.js" (entry point)
//
// Byte-identical error — separator-agnostic detection did NOT change the
// resolved path at all. Note there is NO `parser\` segment in the reported
// path, which is inconsistent with the "compiled → parser/worker.js" branch
// finding #1 assumed. This means AT LEAST ONE of the following is false,
// and which one is UNKNOWN — no Windows machine available in this
// environment to observe the real `import.meta.url` shape or the real
// on-disk `--compile` layout directly:
//   (a) import.meta.url on a Windows-compiled binary has the assumed shape
//       (`B:\~BUN\root\<binary>` / `file:///B:/~BUN/root/<binary>`) — it may
//       differ in a way neither finding #1 nor #2 anticipated.
//   (b) multi-entrypoint `--compile` flattening lands worker.js at
//       `<root>\parser\worker.js` on Windows the way it does on macOS/Linux
//       — it may land directly at `<root>\worker.js`, or somewhere else
//       entirely.
//   (c) Bun's `Worker` constructor resolves the URL we hand it the same way
//       `new URL()` does — it may mangle or re-resolve it differently.
// Rather than guess a THIRD hypothesis, resolution is now candidate-based:
// try the plausible layouts in order at runtime and empirically discover
// which one is real (see `workerEntryCandidates` and `ParserPool`'s
// candidate-retry construction below). This sidesteps needing to know which
// of (a)/(b)/(c) is the actual root cause.
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
// Detection is separator- and encoding-agnostic: compiled if the url
// contains "$bunfs" OR "~BUN" anywhere, with no surrounding-slash
// requirement. "~BUN" itself is fixed-case in Bun's own source as of
// 1.3.14; this has NOT been verified against other Bun versions. If Bun
// ever lowercases the drive letter or the marker itself in some future
// version, this detection would need case-insensitive matching; kept
// case-sensitive for now since that's what was empirically observed.

/**
 * Build the ORDERED list of plausible worker-entry locations for a given
 * `import.meta.url`, most-likely-first. Pure and side-effect-free so it is
 * directly unit-testable without spawning real Workers.
 *
 * - Dev (not compiled): only `./worker.js` is plausible — worker.ts is
 *   always a sibling of pool.ts in source.
 * - Compiled: two layouts are plausible, since WINDOWS FINDING #2 proved the
 *   "always ./parser/worker.js" assumption wrong for at least one platform.
 *   `./parser/worker.js` (the macOS/Linux-observed layout) is tried first
 *   because it is verified on two platforms; `./worker.js` (flat, no
 *   `parser/` segment — consistent with the path Windows actually reported
 *   in finding #2) is the fallback.
 *
 * Each relative candidate is resolved through the same two-tier strategy
 * `resolveWorkerEntry` used previously: try the WHATWG URL API first (covers
 * well-formed `file://` bases, including the Windows URL-form and
 * URL-encoded form), falling back to backslash-preserving string join for
 * raw Windows path bases that throw out of `new URL`.
 */
export function workerEntryCandidates(importMetaUrl: string): string[] {
  // FINDING #3 (DIAG from a real windows-x64 runner, run 29125864060):
  // the actual compiled import.meta.url is file:///B:/%7EBUN/root/<binary> —
  // the tilde arrives percent-encoded ("%7EBUN"), which neither "$bunfs" nor
  // "~BUN" matches. Normalize %7E/%7e → "~" before the substring check.
  const normalizedUrl = importMetaUrl.replace(/%7E/gi, "~");
  const isCompiled =
    normalizedUrl.includes("$bunfs") || normalizedUrl.includes("~BUN");
  const relPaths = isCompiled
    ? ["parser/worker.js", "worker.js"]
    : ["worker.js"];

  return relPaths.map((relPath) => {
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
  });
}

/**
 * @deprecated kept only as a thin compatibility shim around
 * `workerEntryCandidates` — returns its first (most-likely) candidate.
 * `ParserPool` no longer uses this directly; it tries the full candidate
 * list at runtime instead. Exported because existing callers/tests may
 * still reference the old single-path name.
 */
export function resolveWorkerEntry(importMetaUrl: string): string {
  return workerEntryCandidates(importMetaUrl)[0];
}

/**
 * Module-level cache of the candidate INDEX that has been empirically
 * proven to load, once any worker in this process has loaded successfully.
 * Subsequent `ParserPool` constructions (and subsequent workers within the
 * same pool) skip straight to it instead of re-probing dead candidates one
 * by one. Reset only by tests via `__resetWorkerEntryCacheForTests`.
 */
let cachedWorkingCandidateIndex: number | null = null;

/** Test-only seam: clear the module-level winning-candidate cache. */
export function __resetWorkerEntryCacheForTests(): void {
  cachedWorkingCandidateIndex = null;
}

const DEFAULT_CANDIDATES = workerEntryCandidates(import.meta.url);

/**
 * Diagnostic helper for callers outside this module (e.g.
 * src/commands/parse-selftest.ts's `--pool` failure path) that need to log
 * WHAT pool.ts resolved without re-deriving the logic themselves. Returns
 * pool.ts's own `import.meta.url` and the exact candidate list derived from
 * it — the same values `ParserPool`'s default constructor argument uses.
 */
export function poolDiagnostics(): { importMetaUrl: string; candidates: string[] } {
  return { importMetaUrl: import.meta.url, candidates: DEFAULT_CANDIDATES };
}

/**
 * How long a single candidate gets to either post ANY message or fire
 * `onerror` before it's presumed dead and the next candidate is tried. Bun
 * fires `onerror` for a genuine ModuleNotFound quickly (well under this),
 * so this timeout mainly guards against failure modes that don't reliably
 * raise `onerror` at all (e.g. a candidate resolving to a path that exists
 * but hangs during module evaluation).
 */
const CANDIDATE_TIMEOUT_MS = 3000;

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
  /** Probe timers for slots still being spawned — cleared on dispose(). */
  private pendingProbeTimers = new Set<ReturnType<typeof setTimeout>>();
  /** True once dispose() has run — cancels in-flight candidate retries. */
  private disposed = false;
  /**
   * Diagnostic trail of every candidate this pool attempted and its outcome
   * — read by callers (e.g. parse-selftest's `--pool` DIAG output) on
   * failure to explain WHICH candidates were tried and why they were
   * rejected, instead of just "it didn't work."
   */
  readonly attemptLog: Array<{ url: string; outcome: "confirmed" | "errored" | "timed-out" }> = [];

  /**
   * @param size number of worker slots to maintain.
   * @param candidates worker-entry candidates to try, most-likely-first.
   *   Defaults to `workerEntryCandidates(import.meta.url)` (this module's
   *   own compiled/dev location). Overridable for tests that need to force
   *   a dead-candidate-then-fallback scenario without depending on the
   *   real compiled/dev layout.
   */
  constructor(size: number, candidates: string[] = DEFAULT_CANDIDATES) {
    // If a previous ParserPool in this process already proved which
    // candidate loads, skip straight to it — no point re-probing dead
    // candidates on every subsequent pool construction.
    const orderedCandidates =
      cachedWorkingCandidateIndex !== null &&
      cachedWorkingCandidateIndex < candidates.length
        ? [
            candidates[cachedWorkingCandidateIndex],
            ...candidates.filter((_, i) => i !== cachedWorkingCandidateIndex),
          ]
        : candidates;

    for (let i = 0; i < size; i++) {
      this.spawnSlot(orderedCandidates);
    }
  }

  /**
   * Spawn one worker slot, trying `candidates` in order until one loads
   * successfully (first message received, or no error within
   * `CANDIDATE_TIMEOUT_MS`). A candidate that errors or times out before
   * ever posting a message is presumed dead: terminate it and retry the
   * SAME slot with the next candidate. Once a candidate is confirmed live,
   * the winning index is cached module-wide and the slot's `onmessage`/
   * `onerror` fall back to the pool's normal steady-state semantics
   * (identical to the pre-candidate-resolver behavior).
   */
  private spawnSlot(candidates: string[], candidateIndex = 0): void {
    if (this.disposed) return;
    if (candidateIndex >= candidates.length) {
      // Every candidate failed for this slot — no live worker to add.
      // drainQueue()'s dead-pool guard already handles workers.length === 0.
      this.drainQueue();
      return;
    }

    const url = candidates[candidateIndex];
    const worker = new Worker(url);
    let confirmed = false;

    const timer = setTimeout(() => {
      if (confirmed || this.disposed) return;
      this.pendingProbeTimers.delete(timer);
      this.attemptLog.push({ url, outcome: "timed-out" });
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      this.spawnSlot(candidates, candidateIndex + 1);
    }, CANDIDATE_TIMEOUT_MS);
    this.pendingProbeTimers.add(timer);

    const confirm = () => {
      if (confirmed) return;
      confirmed = true;
      clearTimeout(timer);
      this.pendingProbeTimers.delete(timer);
      this.attemptLog.push({ url, outcome: "confirmed" });
      if (candidateIndex !== cachedWorkingCandidateIndex) {
        cachedWorkingCandidateIndex = candidateIndex;
      }
    };

    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const isFirstConfirmation = !confirmed;
      confirm();
      const res = event.data;
      const entry = this.pending.get(res.id);
      if (!entry) {
        // The probe response (its id was never registered in `pending`)
        // lands here — this IS the expected confirmation path, not an edge
        // case. The worker just proved its candidate loads; make it
        // available for real jobs now.
        if (isFirstConfirmation) this.idle.push(worker);
        this.drainQueue();
        return;
      }
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
      if (!confirmed) {
        // Load failure before this slot ever proved itself: this candidate
        // is dead. Nothing was ever dispatched to this worker (it never
        // entered `idle`, since only confirmed workers do), so there is no
        // pending job to settle here — just retry the same slot with the
        // next candidate.
        clearTimeout(timer);
        this.pendingProbeTimers.delete(timer);
        this.attemptLog.push({
          url,
          outcome: "errored",
        });
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        this.workers = this.workers.filter((w) => w !== worker);
        if (!this.disposed) this.spawnSlot(candidates, candidateIndex + 1);
        return;
      }

      console.error(
        `[project-brain] worker error: ${event.message || String(event.error || "unknown worker error")}`,
      );
      // A worker that errors out AFTER having loaded successfully (e.g. a
      // genuine parse-time crash) will never post the responses its
      // currently-pending jobs are waiting on, so those jobs' promises
      // would hang forever. Settle every pending job assigned to THIS
      // worker with a failed result instead of leaving them unresolved.
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

    // The slot counts toward `workers` immediately (preserves the
    // size-invariant: `workers.length === size` right after construction),
    // but is intentionally NOT added to `idle` yet — `drainQueue` only
    // dispatches to idle workers, so no job reaches this worker until its
    // candidate is confirmed live via `onmessage` above.
    this.workers.push(worker);

    // Confirming a candidate requires observing a real `onmessage`/`onerror`
    // from the worker — but unconfirmed workers are deliberately kept out of
    // `idle`, so a REAL queued job would never reach one to trigger that.
    // Send a trivial, self-contained probe request (empty content — no file
    // I/O, no external state) so the worker's own reply loop (worker.ts's
    // `self.onmessage`, which always responds once the module has loaded)
    // is what confirms the slot. This reuses the exact wire protocol instead
    // of inventing a parallel handshake message worker.ts would need to
    // special-case.
    const probeId = this.nextId++;
    const probeReq: ParseRequest = { id: probeId, path: "__pool_probe__", content: "", ext: ".ts" };
    worker.postMessage(probeReq);
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
    this.disposed = true;
    for (const timer of this.pendingProbeTimers) clearTimeout(timer);
    this.pendingProbeTimers.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
