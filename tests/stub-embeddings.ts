import type { EmbeddingClient } from "../src/types.js";

/**
 * An embedding client that never touches the network.
 *
 * Pass this to createServer/createHttpServer in any test that does not
 * actually assert on embedding values. Without it, startup probes the real
 * Ollama: 2.7s against an idle one and over 5s against a busy one, which is
 * enough to blow bun's 5s default timeout and fail tests that have nothing to
 * do with embeddings. CI never caught it — with no Ollama listening the probe
 * fails in 6ms.
 */
export const stubEmbeddings: EmbeddingClient = {
  model: "stub-embeddings",
  dim: 4,
  embed: async (texts: string[]) => texts.map(() => [0, 0, 0, 0]),
} as unknown as EmbeddingClient;
