import { chunkContent } from "../indexer/parser.js";
import type { Chunk, EmbeddingClient, VectorStore } from "../types.js";
import { OkfBundleError, readBundle } from "./bundle.js";
import { conceptToIndexable, OKF_MODULE } from "./indexable.js";
import type { OkfIssue } from "./validate.js";

export interface SyncBundleDeps {
  project: string;
  store: VectorStore;
  embeddings: EmbeddingClient;
}

export interface SyncBundleResult {
  /** Concepts indexed this run. */
  concepts: number;
  /** Chunks written (a concept splits by heading). */
  chunks: number;
  /** Sources dropped because their concept left the bundle. */
  removed: string[];
  /** Conformance problems found while reading (§11) — reported, never fatal. */
  issues: OkfIssue[];
  okfVersion: string | null;
}

/**
 * Indexes an OKF bundle into a project's brain.
 *
 * This is what makes a bundle worth writing: once indexed, a question like
 * "why does this read bytes instead of a path" retrieves the decision, not the
 * lines — knowledge the AST cannot hold and the structural tools cannot answer.
 *
 * Removal is handled alongside insertion. Every source currently filed under
 * the OKF module is passed to `batchReplace`, so a concept deleted from the
 * bundle also leaves the index instead of lingering as retracted advice the
 * brain keeps repeating.
 */
export async function syncBundle(root: string, deps: SyncBundleDeps): Promise<SyncBundleResult> {
  const bundle = await readBundle(root);
  const indexables = bundle.files
    .map(conceptToIndexable)
    .filter((i): i is NonNullable<typeof i> => i !== null);

  const priorSources = new Set(
    (await deps.store.getModuleChunks(deps.project, OKF_MODULE)).map((c) => c.source)
  );
  const currentSources = new Set(indexables.map((i) => i.source));
  const removed = [...priorSources].filter((s) => !currentSources.has(s)).sort();

  if (indexables.length === 0 && removed.length === 0) {
    return { concepts: 0, chunks: 0, removed: [], issues: bundle.issues, okfVersion: bundle.okfVersion };
  }

  const raw = indexables.flatMap((i) => chunkContent(i.content, i.source, OKF_MODULE));

  let chunks: Chunk[] = [];
  if (raw.length > 0) {
    const vectors = await deps.embeddings.embed(raw.map((c) => c.content));
    if (!vectors) {
      throw new OkfBundleError(
        "Cannot index the OKF bundle — embedding service unavailable."
      );
    }
    chunks = raw.map((c, i) => ({ ...c, vector: vectors[i]! }));
  }

  const tableMeta = deps.embeddings.model
    ? { model: deps.embeddings.model, dim: deps.embeddings.dim }
    : undefined;
  await deps.store.ensureTable(deps.project, tableMeta);
  await deps.store.batchReplace(deps.project, [...currentSources, ...removed], chunks);

  return {
    concepts: indexables.length,
    chunks: chunks.length,
    removed,
    issues: bundle.issues,
    okfVersion: bundle.okfVersion,
  };
}
