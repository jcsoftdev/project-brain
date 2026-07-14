/**
 * LRU cache for query-embedding vectors, keyed by (model, query). The
 * embed round-trip to Ollama (~1s) dominates search latency; identical
 * queries within a serve-process lifetime should not pay it twice.
 * Only QUERY embeddings are cached (bounded, user-driven); document
 * embeddings during sync are not (unbounded, hash-gated elsewhere).
 */
export class QueryEmbedCache {
  private map = new Map<string, number[]>();

  constructor(private readonly max = 256) {}

  private key(model: string, query: string): string {
    return `${model} ${query}`;
  }

  get(model: string, query: string): number[] | undefined {
    const k = this.key(model, query);
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v); // move to most-recently-used
    }
    return v;
  }

  set(model: string, query: string, vec: number[]): void {
    const k = this.key(model, query);
    this.map.delete(k);
    this.map.set(k, vec);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
