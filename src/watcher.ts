import { watch as fsWatch } from "node:fs";
import { runSync } from "./commands/sync.js";
import { WATCHER_DEBOUNCE_MS, WATCHER_ALWAYS_IGNORE, WATCHER_MAX_BATCH } from "./constants.js";
import type { EmbeddingClient, VectorStore } from "./types.js";
import type { GraphStore } from "./graph/store.js";

/** A started filesystem watch handle. */
export interface WatchHandle {
  close(): void;
}

/**
 * Registers a recursive filesystem watcher. Injectable so tests can supply a
 * fake without touching the real filesystem.
 *
 * @param root    - Directory to watch recursively.
 * @param onEvent - Invoked with the changed path (relative to root) per event.
 */
export type WatchFn = (
  root: string,
  onEvent: (filename: string) => void
) => WatchHandle;

/** Default: node:fs recursive watch (Bun has no Bun.watch). */
const defaultWatchFn: WatchFn = (root, onEvent) => {
  const w = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (filename) onEvent(filename.toString());
  });
  return { close: () => w.close() };
};

export interface WatcherOptions {
  /** Absolute path to the project root. */
  root: string;
  /** Project identifier used as store namespace. */
  projectId: string;
  /** Injected store. */
  store: VectorStore;
  /** Injected embedding client. */
  embeddings: EmbeddingClient;
  /** Debounce delay in milliseconds. Defaults to WATCHER_DEBOUNCE_MS. */
  debounceMs?: number;
  /** Filesystem watch factory. Defaults to node:fs recursive watch. */
  watchFn?: WatchFn;
  /**
   * Shared structural graph (owned by the MCP server). Forwarded to runSync so
   * the watcher writes the SAME graph.db the server reads, instead of opening a
   * second connection on the same WAL.
   */
  graph?: GraphStore;
}

/**
 * A debounced trigger function with lifecycle controls used by stop() to
 * quiesce all writers before the shared graph is closed.
 */
export interface DebouncedSync {
  /** Schedule a sync for the given path (batched within the quiet period). */
  (path: string): void;
  /**
   * Cancel a pending (not-yet-fired) debounce timer so NO new sync starts.
   * Does NOT affect an already-running sync — await drain() for that.
   */
  cancel(): void;
  /**
   * Resolve once any in-flight sync chain has completed. Resolves immediately
   * when nothing is running. Used by FileWatcher.stop() to guarantee writers
   * have quiesced before the caller closes the shared graph (use-after-close).
   */
  drain(): Promise<void>;
}

/**
 * Pure helper: creates a debounced function that batches rapid calls
 * and invokes the callback once per quiet period with the accumulated paths.
 *
 * The returned function exposes cancel()/drain() so an owner (FileWatcher) can
 * stop the pending timer and await any in-flight sync before tearing down the
 * shared graph connection.
 *
 * @param callback - Function receiving all paths accumulated during the quiet period.
 * @param delayMs  - Quiet-period duration in milliseconds.
 */
export function debounceSync(
  callback: (paths: string[]) => Promise<void>,
  delayMs: number
): DebouncedSync {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();
  // Serialized chain of sync runs. Each debounce wave APPENDS to the tail rather
  // than starting concurrently, so two runSync calls never write the shared graph
  // at once, and drain() can await the WHOLE chain — not just the latest run.
  // (A single-slot "inFlight" lost the reference to an earlier still-running sync
  // when a new wave started, letting drain()/graph.close() race a live writer.)
  let chain: Promise<void> = Promise.resolve();
  // Count of queued-or-running runs; the chain is fully idle only at 0.
  let running = 0;

  const trigger = (path: string) => {
    pending.add(path);

    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      // Dedupe via Set; snapshot and clear before async work
      const unique = [...pending];
      pending.clear();

      // Split into bounded waves of ≤ WATCHER_MAX_BATCH and deliver sequentially
      const waves: string[][] = [];
      for (let i = 0; i < unique.length; i += WATCHER_MAX_BATCH) {
        waves.push(unique.slice(i, i + WATCHER_MAX_BATCH));
      }

      // Append to the serialized chain (errors surfaced via console.warn). The
      // chain never rejects (catch swallows), so drain()'s await cannot throw.
      running++;
      chain = chain
        .then(async () => {
          for (const wave of waves) {
            await callback(wave);
          }
        })
        .catch((err) => {
          console.warn("[watcher] sync error:", err);
        })
        .finally(() => {
          running--;
        });
    }, delayMs);
  };

  (trigger as DebouncedSync).cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };

  (trigger as DebouncedSync).drain = async () => {
    // Await the tail until the chain is fully idle. A run appended while we were
    // awaiting (e.g. a timer that fired just before cancel()) reassigns `chain`,
    // so loop until no run remains queued or in-flight.
    while (running > 0) {
      await chain;
    }
  };

  return trigger as DebouncedSync;
}

/**
 * FileWatcher watches a project directory for changes and triggers
 * incremental sync automatically.
 */
export class FileWatcher {
  private readonly options: Required<Omit<WatcherOptions, "graph">> & Pick<WatcherOptions, "graph">;
  private fsWatcher: WatchHandle | null = null;
  private readonly debounced: DebouncedSync;

  constructor(options: WatcherOptions) {
    this.options = {
      ...options,
      debounceMs: options.debounceMs ?? WATCHER_DEBOUNCE_MS,
      watchFn: options.watchFn ?? defaultWatchFn,
    };

    this.debounced = debounceSync(
      (changedFiles) => this.handleChanges(changedFiles),
      this.options.debounceMs
    );
  }

  /** Start watching the project root directory. */
  start(): void {
    if (this.fsWatcher !== null) {
      // Already watching — idempotent
      return;
    }

    try {
      this.fsWatcher = this.options.watchFn(this.options.root, (filename) => {
        if (!filename) return;

        // Reject always-ignored paths
        const normalizedFilename = filename.replace(/\\/g, "/");
        const shouldSkip = WATCHER_ALWAYS_IGNORE.some((pattern) =>
          normalizedFilename.startsWith(pattern) ||
          normalizedFilename.includes("/" + pattern.replace(/\/$/, ""))
        );
        if (shouldSkip) return;

        this.debounced(filename);
      });
    } catch (err) {
      // Filesystem watching is not available in all environments — degrade gracefully
      console.warn("[watcher] File watching not available:", err);
    }
  }

  /**
   * Stop the watcher. Safe to call before start().
   *
   * Ordering matters to avoid a use-after-close on the shared graph (the
   * server closes graph right after stop() resolves):
   *   1. Cancel the pending debounce timer so NO new sync starts.
   *   2. Close the fs watch handle so NO new events arrive.
   *   3. Await any in-flight sync so all writers have quiesced.
   */
  async stop(): Promise<void> {
    // 1. Stop any not-yet-fired debounce from starting a new sync.
    this.debounced.cancel();

    // 2. Detach from the filesystem (no more events → no more debounced calls).
    if (this.fsWatcher !== null) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }

    // 3. Drain the in-flight sync so its graph writes finish BEFORE we return
    //    (and before the caller closes the shared graph connection).
    await this.debounced.drain();
  }

  private async handleChanges(changedFiles: string[]): Promise<void> {
    try {
      await runSync({
        root: this.options.root,
        projectId: this.options.projectId,
        store: this.options.store,
        embeddings: this.options.embeddings,
        changedFiles,
        graph: this.options.graph,
      });
    } catch (err) {
      console.warn("[watcher] sync failed:", err);
    }
  }
}
