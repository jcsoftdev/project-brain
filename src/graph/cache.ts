/**
 * Bounded, self-closing cache of structural-graph handles.
 *
 * The MCP structural tools can target ANOTHER project by id, and each
 * resolution opens that project's `.project-brain/graph.db` — one SQLite
 * handle apiece. In the long-lived `serve` process an unbounded Map of those
 * handles means every project a session ever touched holds a connection until
 * the process dies, and shutdown had no way to release them at all.
 *
 * This is the same guard LanceDbStore applies to its own table handles
 * (TABLE_CACHE_MAX in store/lancedb.ts) — same lifetime, same shape of cache,
 * so the same bound and the same eviction-closes-the-handle rule.
 *
 * Generic over the handle type purely so eviction/teardown can be tested
 * without opening real databases.
 */

/** How many foreign graph handles stay open at once. Matches TABLE_CACHE_MAX's
 * reasoning: enough that realistic cross-project work never thrashes, small
 * enough that a long-lived process cannot accumulate handles without bound. */
export const GRAPH_CACHE_MAX = 8;

interface Closeable {
  close(): void;
}

export class GraphCache<T extends Closeable = Closeable> {
  /** Insertion order IS recency order: `get`/`set` re-insert to move a key to
   * the end, so the first key is always the least recently used. */
  private entries = new Map<string, T>();

  constructor(private readonly max: number = GRAPH_CACHE_MAX) {}

  get size(): number {
    return this.entries.size;
  }

  /** Read a handle and mark it most-recently-used. */
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  /**
   * Insert or refresh a handle, closing whatever it displaces: the previous
   * value under the same key (nothing references it anymore) and the
   * least-recently-used entry once the cache exceeds `max`. Re-setting a key
   * to the SAME handle only touches recency — closing it there would release a
   * connection the cache is still handing out.
   */
  set(key: string, value: T): void {
    const previous = this.entries.get(key);
    if (previous !== undefined && previous !== value) safeClose(previous);
    this.entries.delete(key);
    this.entries.set(key, value);

    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      safeClose(evicted);
    }
  }

  /**
   * Release every handle and empty the cache. Idempotent, and one failing
   * handle must not strand the rest — shutdown gets a single attempt, so a
   * throw partway through would leak every connection after it.
   */
  close(): void {
    for (const handle of this.entries.values()) safeClose(handle);
    this.entries.clear();
  }
}

function safeClose(handle: Closeable): void {
  try {
    handle.close();
  } catch {
    /* already closed, or a handle that never opened cleanly — nothing left to do */
  }
}
