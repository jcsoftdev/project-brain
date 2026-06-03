export interface ModelSpec { key: string; model: string; dim: number; }

export const DEFAULT_MODEL_KEY = "nomic-code";

const REGISTRY: Record<string, ModelSpec> = {
  "nomic-code": { key: "nomic-code", model: "nomic-embed-code", dim: 768 },
  "nomic-text": { key: "nomic-text", model: "nomic-embed-text", dim: 768 },
};

export function resolveModel(key: string | undefined): ModelSpec {
  const k = key ?? DEFAULT_MODEL_KEY;
  const spec = REGISTRY[k];
  if (!spec) throw new Error(`Unknown embedding model '${k}'. Known: ${Object.keys(REGISTRY).join(", ")}`);
  return spec;
}

export function registerModel(spec: ModelSpec): void { REGISTRY[spec.key] = spec; }
