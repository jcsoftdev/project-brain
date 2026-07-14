import { resolveModel, DEFAULT_MODEL_KEY } from "./registry.js";
import { OllamaEmbeddingClient } from "./ollama.js";
import { EmbeddingPool } from "./pool.js";
import type { EmbeddingClient } from "../types.js";

// ── Injectable dependency types ────────────────────────────────────────────

/** Injectable availability checker: returns true if model is installed in Ollama. */
type IsAvailableFn = (model: string) => Promise<boolean>;

/** Injectable pull function: pulls the model and returns true on success. */
type PullFn = (host: string, model: string) => Promise<boolean>;

/** Injectable embed function: returns embeddings for the given texts. */
type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

// ── Public option types ────────────────────────────────────────────────────

export interface EnsureOptions {
  /** Injectable availability checker. Defaults to real Ollama tags probe. */
  isAvailable?: IsAvailableFn;
  /** Injectable pull function. Defaults to real Ollama pull API. */
  pull?: PullFn;
  /** Logger line. Defaults to process.stderr.write. */
  log?: (msg: string) => void;
}

export interface DetectDimOptions {
  /** Injectable embed function. Defaults to real Ollama embed API. */
  embed?: EmbedFn;
}

export interface FactoryOptions {
  /** Override the Ollama host (defaults to OLLAMA_HOST constant). */
  host?: string;
  /**
   * When true: if the preferred model is absent, pull it (first-run CLI path).
   * When false/undefined: never pull — fall back silently (server boot path).
   */
  autoPull?: boolean;
  /**
   * Injectable availability checker. When omitted, real HTTP probe is used.
   * When it throws, factory treats it as "unreachable".
   */
  isModelAvailable?: IsAvailableFn;
  /** Injectable pull function for DI in tests. */
  pull?: PullFn;
  /** Injectable embed function for dim detection in tests. */
  embed?: EmbedFn;
}

// ── ensureEmbeddingModel ───────────────────────────────────────────────────

/**
 * Ensure an embedding model is available in Ollama.
 *
 * - If already present → return true immediately.
 * - If absent → pull (POST /api/pull, no timeout).
 *   Logs one line: "[project-brain] pulling embedding model '<model>' (first run, may take a while)..."
 * - If Ollama unreachable → return false (tolerant, never throws).
 */
export async function ensureEmbeddingModel(
  host: string,
  model: string,
  opts: EnsureOptions = {}
): Promise<boolean> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const checkAvailable = opts.isAvailable ?? makeDefaultAvailabilityChecker(host);
  const doPull = opts.pull ?? makeDefaultPullFn();

  try {
    const available = await checkAvailable(model);
    if (available) return true;

    log(`[project-brain] pulling embedding model '${model}' (first run, may take a while)...`);
    return await doPull(host, model);
  } catch {
    // Ollama unreachable or any unexpected error — be tolerant
    return false;
  }
}

// ── detectDim ─────────────────────────────────────────────────────────────

/**
 * Detect the embedding dimension of a model by running a single embed call.
 * Returns the vector length on success, or null on any failure.
 */
export async function detectDim(
  host: string,
  model: string,
  opts: DetectDimOptions = {}
): Promise<number | null> {
  const doEmbed = opts.embed ?? makeDefaultEmbedFn(host, model);

  try {
    const result = await doEmbed(["dim-probe"]);
    return result?.[0]?.length ?? null;
  } catch {
    return null;
  }
}

// ── createEmbeddingClient ─────────────────────────────────────────────────

/**
 * Parse BRAIN_OLLAMA_HOSTS into a list of host URLs: comma-split, trim,
 * drop empties. Returns an empty array when unset/blank (single/default
 * host path — unaffected).
 */
export function parseOllamaHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/**
 * Resolve and construct an OllamaEmbeddingClient with auto-pull and dim detection.
 *
 * Resolution order:
 *  1. Resolve model spec from registry using modelKey (default: DEFAULT_MODEL_KEY = qwen3-embedding).
 *  2a. If autoPull=true: pull if absent. If pull fails → fall back to nomic-text, pull that too.
 *  2b. If autoPull=false/undefined: check availability; if absent → fall back to nomic-text (no pull).
 *  3. Detect dim via a real embed probe (injected or real). Fall back to spec.dim ?? 768.
 *  4. Construct and return OllamaEmbeddingClient.
 *
 * Multi-host pooling: when BRAIN_OLLAMA_HOSTS is set with 2+ comma-separated
 * hosts, model resolution/autoPull/detectDim runs ONCE (against the first
 * host) and the resolved model+dim are fanned out to one OllamaEmbeddingClient
 * per host, wrapped in an EmbeddingPool for round-robin throughput. A single
 * host (or the env var unset) preserves today's exact single-client behavior.
 */
export async function createEmbeddingClient(
  modelKey?: string,
  options: FactoryOptions = {}
): Promise<EmbeddingClient> {
  const { OLLAMA_HOST } = await import("../constants.js");
  const pooledHosts = parseOllamaHosts(process.env.BRAIN_OLLAMA_HOSTS);
  const usePool = pooledHosts.length >= 2;
  // Multi-host pool: model resolution/autoPull/detectDim below runs ONCE,
  // against the first pooled host; the resolved model+dim then fan out to
  // one OllamaEmbeddingClient per host at the bottom of this function.
  const host = usePool ? pooledHosts[0] : options.host ?? OLLAMA_HOST;

  const spec = resolveModel(modelKey);
  const checkAvailability = options.isModelAvailable ?? makeDefaultAvailabilityChecker(host);
  const doPull = options.pull ?? makeDefaultPullFn();

  let chosenModel = spec.model;
  let chosenSpecDim = spec.dim;

  if (options.autoPull === true) {
    // CLI path: pull if needed
    const ok = await ensureEmbeddingModel(host, spec.model, {
      isAvailable: options.isModelAvailable,
      pull: options.pull,
    });

    if (!ok) {
      // Primary pull failed → fall back to nomic-text
      const fallback = resolveModel("nomic-text");
      process.stderr.write(
        `[project-brain] could not ensure '${spec.model}'; falling back to '${fallback.model}'.\n`
      );
      // Try to ensure fallback too (best-effort, nomic-text is tiny)
      await ensureEmbeddingModel(host, fallback.model, {
        isAvailable: options.isModelAvailable,
        pull: options.pull,
      });
      chosenModel = fallback.model;
      chosenSpecDim = fallback.dim;
    }
  } else {
    // Server path: check only, no pull
    try {
      const available = await checkAvailability(spec.model);
      if (!available) {
        const fallback = resolveModel("nomic-text");
        process.stderr.write(
          `[project-brain] embedding model '${spec.model}' not installed; falling back to nomic-embed-text. Run: ollama pull ${spec.model} for best code retrieval.\n`
        );
        chosenModel = fallback.model;
        chosenSpecDim = fallback.dim;
      }
    } catch {
      // Ollama unreachable — use the requested spec, don't block startup
    }
  }

  // Detect actual dim via a real embed probe
  const dim = (await detectDim(host, chosenModel, { embed: options.embed })) ?? chosenSpecDim ?? 768;

  if (usePool) {
    const clients = pooledHosts.map(
      (h) => new OllamaEmbeddingClient(h, undefined, chosenModel, dim)
    );
    return new EmbeddingPool(clients);
  }

  return new OllamaEmbeddingClient(host, undefined, chosenModel, dim);
}

// ── Default injectable implementations ───────────────────────────────────

/**
 * Check if a query model is satisfied by any installed model name, respecting
 * Ollama's tag-boundary semantics: an installed name matches only if it equals
 * the query exactly, or starts with "<query>:" (a tag boundary) — never an
 * arbitrary substring prefix. This prevents e.g. "nomic-embed-text-v2:latest"
 * from falsely satisfying a query for "nomic-embed-text".
 */
export function isModelInstalled(installedNames: string[], query: string): boolean {
  return installedNames.some((name) => name === query || name.startsWith(`${query}:`));
}

/**
 * Default availability checker: queries Ollama tags endpoint.
 * Matches at an Ollama tag boundary — e.g. "nomic-embed-text:latest" matches
 * "nomic-embed-text", but "nomic-embed-text-v2:latest" does not.
 */
function makeDefaultAvailabilityChecker(host: string): IsAvailableFn {
  return async (model: string): Promise<boolean> => {
    try {
      const response = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      return isModelInstalled(models.map((m) => m.name), model);
    } catch {
      return false;
    }
  };
}

/**
 * Default pull function: POST /api/pull with stream:false.
 * No timeout — pulls can take minutes for large models.
 */
function makeDefaultPullFn(): PullFn {
  return async (host: string, model: string): Promise<boolean> => {
    try {
      const response = await fetch(`${host}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

/**
 * Default embed function for dim detection: uses the Ollama embed API directly.
 */
function makeDefaultEmbedFn(host: string, model: string): EmbedFn {
  return async (texts: string[]): Promise<number[][] | null> => {
    try {
      const response = await fetch(`${host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { embeddings: number[][] };
      return data.embeddings ?? null;
    } catch {
      return null;
    }
  };
}
