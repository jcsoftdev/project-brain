import { watch as fsWatch } from "node:fs";
import { runSync } from "./commands/sync.js";
import { WATCHER_DEBOUNCE_MS, WATCHER_ALWAYS_IGNORE } from "./constants.js";
import type { EmbeddingClient, VectorStore } from "./types.js";

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
}

/**
 * Pure helper: creates a debounced function that batches rapid calls
 * and invokes the callback once per quiet period with the accumulated paths.
 *
 * @param callback - Function receiving all paths accumulated during the quiet period.
 * @param delayMs  - Quiet-period duration in milliseconds.
 */
export function debounceSync(
  callback: (paths: string[]) => Promise<void>,
  delayMs: number
): (path: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending: string[] = [];

  return (path: string) => {
    pending.push(path);

    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      const batch = [...pending];
      pending.length = 0;
      // Fire and forget — errors are surfaced via console.warn
      callback(batch).catch((err) => {
        console.warn("[watcher] sync error:", err);
      });
    }, delayMs);
  };
}

/**
 * FileWatcher watches a project directory for changes and triggers
 * incremental sync automatically.
 */
export class FileWatcher {
  private readonly options: Required<WatcherOptions>;
  private fsWatcher: WatchHandle | null = null;
  private readonly debounced: (path: string) => void;

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

  /** Stop the watcher. Safe to call before start(). */
  async stop(): Promise<void> {
    if (this.fsWatcher !== null) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private async handleChanges(changedFiles: string[]): Promise<void> {
    try {
      await runSync({
        root: this.options.root,
        projectId: this.options.projectId,
        store: this.options.store,
        embeddings: this.options.embeddings,
        changedFiles,
      });
    } catch (err) {
      console.warn("[watcher] sync failed:", err);
    }
  }
}
