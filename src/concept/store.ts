import { chunkContent } from "../indexer/parser.js";
import type { Chunk, EmbeddingClient, VectorStore } from "../types.js";

/** Deterministic storage source for a module's concept doc. Ends in .md so chunkContent's markdown-heading path applies. */
export function conceptSource(module: string): string {
  return `concept:${module}.md`;
}

/** Reassembles a module's stored concept doc from its heading chunks, in original order. */
export async function readConceptDoc(
  project: string,
  module: string,
  store: VectorStore
): Promise<string> {
  const chunks = await store.getModuleChunks(project, "concept");
  const source = conceptSource(module);
  return chunks
    .filter((c) => c.source === source)
    .sort((a, b) => (a.start_line ?? 0) - (b.start_line ?? 0))
    .map((c) => c.content)
    .join("\n\n");
}

/** Chunks a module's concept markdown by heading and replaces its prior chunks in the store. */
export async function writeConceptDoc(
  project: string,
  module: string,
  markdown: string,
  deps: { store: VectorStore; embeddings: EmbeddingClient }
): Promise<void> {
  const source = conceptSource(module);
  const raw = chunkContent(markdown, source, "concept");
  if (raw.length === 0) return;

  const vectors = await deps.embeddings.embed(raw.map((c) => c.content));
  if (!vectors) {
    throw new Error("Cannot store concept doc — embedding service unavailable.");
  }

  const chunks: Chunk[] = raw.map((c, i) => ({ ...c, vector: vectors[i] }));
  await deps.store.batchReplace(project, [source], chunks);
}
