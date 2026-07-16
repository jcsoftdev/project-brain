import type { EmbeddingClient, TableMeta } from "../types.js";

/** Signature for reading table metadata (injectable for testing). */
type ReadMetaFn = (dbPath: string, project: string) => Promise<TableMeta | null>;

/** Signature for constructing a new EmbeddingClient for a given model+dim. */
type ConstructFn = (model: string, dim: number) => EmbeddingClient;

export interface EmbeddingResolverOptions {
  dbPath: string;
  host: string;
  defaultClient: EmbeddingClient;
  /** Injectable for tests. Defaults to readTableMeta from store/meta.ts. */
  readMeta?: ReadMetaFn;
  /** Injectable for tests. Defaults to constructing a new OllamaEmbeddingClient. */
  construct?: ConstructFn;
}

/**
 * Create a per-project embedding resolver.
 *
 * Given a project name, reads the table's stored metadata (model + dim) and returns
 * the appropriate EmbeddingClient:
 *   - If meta is null OR meta.model === defaultClient.model → return defaultClient (no rebuild).
 *   - Else → return a cached OllamaEmbeddingClient keyed by `${model}:${dim}`.
 *
 * The cache lives inside the closure — one Map per resolver instance.
 * autoPull is NOT performed here (hot path; if the model isn't installed, embed returns null → EMBEDDINGS_UNAVAILABLE).
 */
export function makeEmbeddingResolver(opts: EmbeddingResolverOptions): (project: string) => Promise<EmbeddingClient> {
  const { dbPath, host, defaultClient } = opts;

  // Lazy-load defaults to avoid circular-import issues at module evaluation time
  const getReadMeta = async (): Promise<ReadMetaFn> => {
    if (opts.readMeta) return opts.readMeta;
    const { readTableMeta } = await import("../store/meta.js");
    return readTableMeta;
  };

  const getConstruct = async (): Promise<ConstructFn> => {
    if (opts.construct) return opts.construct;
    const { OllamaEmbeddingClient } = await import("./ollama.js");
    return (model, dim) => new OllamaEmbeddingClient(host, undefined, model, dim);
  };

  // Cache keyed by `${model}:${dim}` — reuse across projects that share the same model+dim
  const cache = new Map<string, EmbeddingClient>();

  return async (project: string): Promise<EmbeddingClient> => {
    const readMeta = await getReadMeta();
    const meta = await readMeta(dbPath, project);

    // Lexical-only project (see src/embeddings/null.ts) — route directly to
    // NullEmbeddingClient, bypassing Ollama entirely. Must be checked before
    // the defaultClient-reuse branch below: "none" never equals a real
    // default model name, but this makes the intent explicit and avoids
    // ever constructing a real OllamaEmbeddingClient("none", ...) that would
    // pay a doomed network round-trip (or retry/backoff delay when Ollama is
    // down) on every query.
    if (meta?.model === "none") {
      const cacheKey = "none";
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      const { NullEmbeddingClient } = await import("./null.js");
      const client = new NullEmbeddingClient();
      cache.set(cacheKey, client);
      return client;
    }

    // No meta or same model as the default → reuse default (no allocation)
    if (!meta || meta.model === defaultClient.model) {
      return defaultClient;
    }

    const cacheKey = `${meta.model}:${meta.dim}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const construct = await getConstruct();
    const client = construct(meta.model, meta.dim);
    cache.set(cacheKey, client);
    return client;
  };
}
