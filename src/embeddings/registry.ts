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
  if (!k) throw new Error(`Embedding model key must be a non-empty string. Known registry keys: ${Object.keys(REGISTRY).join(", ")}`);
  const spec = REGISTRY[k];
  // Known registry key → return the spec as-is
  if (spec) return spec;
  // Unknown key but non-empty → treat as a raw Ollama model name (e.g. "nomic-embed-text", "qwen3-embedding:0.6b")
  // dim is left undefined — it will be auto-detected downstream via detectDim.
  return { key: k, model: k };
}

export function registerModel(spec: ModelSpec): void { REGISTRY[spec.key] = spec; }
