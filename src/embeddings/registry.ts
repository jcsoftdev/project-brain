export interface ModelSpec {
  key: string;
  model: string;
  /** Optional dim hint — used only when detectDim cannot run (offline/unreachable). */
  dim?: number;
}

export const DEFAULT_MODEL_KEY = "qwen3-embedding";

const REGISTRY: Record<string, ModelSpec> = {
  // Default: 0.6b variant — 1024-dim, fast, code-capable. The bare tag resolves
  // to the 8B model (4096-dim) which is far too slow for bulk indexing batches.
  "qwen3-embedding": { key: "qwen3-embedding", model: "qwen3-embedding:0.6b" },
  "nomic-text": { key: "nomic-text", model: "nomic-embed-text", dim: 768 },
};

export function resolveModel(key: string | undefined): ModelSpec {
  const k = key ?? DEFAULT_MODEL_KEY;
  const spec = REGISTRY[k];
  if (!spec) throw new Error(`Unknown embedding model '${k}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return spec;
}

export function registerModel(spec: ModelSpec): void { REGISTRY[spec.key] = spec; }
