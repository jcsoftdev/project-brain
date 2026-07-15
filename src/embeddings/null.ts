import type { EmbeddingClient } from "../types.js";

/**
 * No-op embedding client for lexical-only projects (user chose "no
 * embeddings" at init/reindex — src/embeddings/model-prompt.ts). embed()
 * always returns null, which is what makes search_context's existing
 * lexical-floor degradation (BM25 fallback, src/tools/search.ts) kick in
 * automatically at query time — this is intended behavior for this mode,
 * not a failure signal. sync.ts has a matching branch (src/commands/
 * sync.ts, "lexical-only" check on embeddings.model === "none") that
 * treats this null as success rather than total embed failure.
 */
export class NullEmbeddingClient implements EmbeddingClient {
  readonly dim = 1;
  readonly model = "none";

  async embed(): Promise<null> {
    return null;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
