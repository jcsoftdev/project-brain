import { join } from "node:path";
import { FileWatcher } from "./watcher.js";
import { acquireWatchLock, type WatchLockHandle } from "./watcher-lock.js";
import { WATCH_ELECTION_RETRY_MS } from "./constants.js";
import type { EmbeddingClient, VectorStore } from "./types.js";
import type { GraphStore } from "./graph/store.js";

interface ServerDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
  /** Shared structural graph owned by the server; forwarded to runSync. */
  graph?: GraphStore;
}

interface ProjectConfig {
  projectId: string;
  root?: string;
}

/**
 * Attempt to read and validate .project-brain/project.json from the given cwd.
 * Returns the parsed config or null if absent or invalid.
 */
async function readProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  const configPath = join(cwd, ".project-brain", "project.json");
  try {
    const raw = await Bun.file(configPath).text();
    const parsed = JSON.parse(raw);
    if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) {
      return null;
    }
    return parsed as ProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Attempt to start a FileWatcher for the given cwd.
 *
 * - Reads .project-brain/project.json from cwd.
 * - If present and valid (has projectId), instantiates FileWatcher, starts it,
 *   and returns it.
 * - If config is absent or invalid, returns null. The caller can still serve
 *   normally — the watcher is optional.
 *
 * This helper is extracted from cli.ts so it can be unit-tested without
 * spawning a real MCP server.
 */
export async function maybeStartWatcher(
  cwd: string,
  deps: ServerDeps
): Promise<FileWatcher | null> {
  const config = await readProjectConfig(cwd);
  if (!config) {
    return null;
  }

  const watcher = new FileWatcher({
    root: config.root ?? cwd,
    projectId: config.projectId,
    store: deps.store,
    embeddings: deps.embeddings,
    graph: deps.graph,
  });

  watcher.start();
  return watcher;
}

/** What startWatchElection hands back — a Stoppable that may or may not be watching. */
export interface WatchElection {
  /** True while THIS process holds the root and has a live watcher on it. */
  readonly watching: boolean;
  /** Stops the watcher if any, releases the root, and cancels the retry. */
  stop(): Promise<void>;
}

interface ElectionOptions extends ServerDeps {
  /** How often a loser re-checks whether the root has been freed. */
  retryMs?: number;
}

/**
 * Run ONE watcher per project root across processes, and keep trying if we lose.
 *
 * Every MCP host starts its own `serve`, and several in one repo is ordinary
 * rather than exceptional. Each used to start its own FileWatcher on the same
 * root, so a single file save fanned out into N independent syncs: N embed
 * passes over identical content, N writes, and N sets of fragments for optimize
 * to clean up behind them. Measured with two watchers on one root and one file
 * written: 2 syncs, 2 batchReplace calls.
 *
 * Losing is not a failure — the loser serves exactly as before and simply does
 * not duplicate the winner's indexing. Serving never depended on the watcher.
 *
 * The retry is what makes the election safe to lose. Without it, killing the
 * elected server would leave the project unwatched until a human happened to
 * restart something; with it, the next check picks the root up. It costs one
 * timer and one file test per interval.
 */
export async function startWatchElection(
  cwd: string,
  opts: ElectionOptions
): Promise<WatchElection> {
  const { retryMs = WATCH_ELECTION_RETRY_MS, ...deps } = opts;

  let watcher: FileWatcher | null = null;
  let lock: WatchLockHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const config = await readProjectConfig(cwd);
  const root = config ? config.root ?? cwd : null;

  const tryWin = async (): Promise<void> => {
    if (stopped || watcher || !root) return;
    const held = await acquireWatchLock(root);
    if (!held) return;
    // Between winning the lock and starting, stop() may have run. Hand the
    // root straight back rather than leaving a watcher nobody will stop.
    if (stopped) {
      await held.release();
      return;
    }
    lock = held;
    watcher = await maybeStartWatcher(cwd, deps);
    if (!watcher) {
      // No project to watch after all — do not sit on a root we cannot serve.
      lock = null;
      await held.release();
    }
  };

  await tryWin();

  if (!watcher && root) {
    timer = setInterval(() => {
      void tryWin().then(() => {
        if (watcher && timer) {
          clearInterval(timer);
          timer = null;
        }
      });
    }, retryMs);
    // Never hold the process open just to keep re-checking.
    (timer as any).unref?.();
  }

  return {
    get watching() {
      return watcher !== null;
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      // Only ever releases a lock THIS process won — a loser must not free the
      // incumbent's root on its way out.
      if (lock) {
        await lock.release();
        lock = null;
      }
    },
  };
}

/** Minimal stoppable handle — what the shutdown handler needs from a watcher. */
interface Stoppable {
  stop(): Promise<void>;
}

/** Minimal closeable handle — the shared graph connection the server owns. */
interface Closeable {
  close(): void;
}

/**
 * Builds a graceful-shutdown handler: stops the watcher (if any), closes every
 * handle it was given (if any), then exits.
 * Extracted from cli.ts so the shutdown path is unit-testable — `exit` is
 * injectable to avoid killing the test process.
 *
 * `graphs` accepts a list because the server owns more than one handle: its own
 * project graph plus the cache of foreign project graphs the structural tools
 * opened on demand. Both must be released, and neither may be skipped because
 * an earlier one threw on close.
 *
 * The returned handler is IDEMPOTENT, and deliberately so. Three independent
 * triggers call it — SIGINT, SIGTERM, and the orphan-check interval — and the
 * interval keeps firing every ORPHAN_CHECK_MS while the first call is still
 * awaiting watcher.stop(), which drains any in-flight sync and can therefore
 * block for minutes. Unguarded, that is a second watcher.stop() and a
 * close() on a handle the first call already released. Repeat calls return the
 * first teardown's promise instead of starting their own.
 */
export function createShutdownHandler(
  watcher: Stoppable | null,
  exit: (code: number) => void = (code) => process.exit(code),
  graphs: Closeable | Closeable[] | null = null
): () => Promise<void> {
  const handles = graphs === null ? [] : Array.isArray(graphs) ? graphs : [graphs];
  let inFlight: Promise<void> | null = null;

  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (watcher) await watcher.stop();
      for (const handle of handles) {
        try { handle.close(); } catch {}
      }
      exit(0);
    })();
    return inFlight;
  };
}
