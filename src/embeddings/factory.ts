import { resolveModel, DEFAULT_MODEL_KEY } from "./registry.js";
import { OllamaEmbeddingClient } from "./ollama.js";

export interface FactoryOptions {
  /** Override the Ollama host (defaults to OLLAMA_HOST constant). */
  host?: string;
  /**
   * Dependency-injectable availability checker.
   * Receives a model name, returns true if the model is installed in Ollama.
   * When omitted, a real HTTP probe against the tags endpoint is used.
   * When it throws, the factory treats it as "unreachable" and skips fallback.
   */
  isModelAvailable?: (model: string) => Promise<boolean>;
}

/**
 * Resolve and construct an OllamaEmbeddingClient with a safe fallback.
 *
 * Resolution order:
 *  1. Resolve model spec from registry using modelKey (default: DEFAULT_MODEL_KEY).
 *  2. Probe availability of the resolved model.
 *     - If NOT available → fall back to "nomic-text" spec and log one warning.
 *     - If Ollama is unreachable (probe throws) → use the requested spec as-is (don't block).
 *  3. Construct and return OllamaEmbeddingClient with the chosen spec.
 */
export async function createEmbeddingClient(
  modelKey?: string,
  options: FactoryOptions = {}
): Promise<OllamaEmbeddingClient> {
  const { OLLAMA_HOST } = await import("../constants.js");
  const host = options.host ?? OLLAMA_HOST;

  const spec = resolveModel(modelKey);

  // Choose the availability checker
  const checkAvailability =
    options.isModelAvailable ?? makeDefaultAvailabilityChecker(host);

  let chosenSpec = spec;

  try {
    const available = await checkAvailability(spec.model);
    if (!available) {
      const fallback = resolveModel("nomic-text");
      process.stderr.write(
        `[project-brain] embedding model '${spec.model}' not installed; falling back to nomic-embed-text. Run: ollama pull ${spec.model} for best code retrieval.\n`
      );
      chosenSpec = fallback;
    }
  } catch {
    // Ollama unreachable — use the requested spec, don't block startup
    chosenSpec = spec;
  }

  return new OllamaEmbeddingClient(host, undefined, chosenSpec.model, chosenSpec.dim);
}

/**
 * Default availability checker: queries Ollama tags endpoint and checks if
 * the model name appears in the installed models list.
 */
function makeDefaultAvailabilityChecker(host: string) {
  return async (model: string): Promise<boolean> => {
    try {
      const response = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      // Match on name prefix — e.g. "nomic-embed-text:latest" matches "nomic-embed-text"
      return models.some((m) => m.name.startsWith(model));
    } catch {
      return false;
    }
  };
}
