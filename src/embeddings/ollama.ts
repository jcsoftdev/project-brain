import { EMBEDDING_MODEL, HEALTH_COOLDOWN_MS, VECTOR_DIM } from "../constants.js";
import type { EmbeddingClient } from "../types.js";

/**
 * Compute embed request timeout in ms, scaling with input size.
 * Floor: 10 000 ms (single-text query). Per-item budget: 600 ms.
 * e.g. 200 texts → 120 000 ms, 50 texts → 30 000 ms.
 */
export function embedTimeoutMs(count: number): number {
  return Math.max(10_000, count * 600);
}

/**
 * Max attempts (1 initial + retries) for a single embed request when the
 * failure looks TRANSIENT (subprocess crash / connection reset / 5xx) —
 * not a sustained/genuine-down condition. Keeps one blip from tripping the
 * circuit breaker and cascading to concurrent sibling requests in the same
 * batch (see mapLimit usage in commands/sync.ts).
 */
const TRANSIENT_RETRY_ATTEMPTS = 3;

/** Base backoff between retry attempts; grows exponentially (150ms, 300ms, ...). */
const TRANSIENT_RETRY_BASE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ollama-backed embedding client with circuit breaker cooldown. */
export class OllamaEmbeddingClient implements EmbeddingClient {
  private readonly host: string;
  readonly model: string;
  private readonly cooldownMs: number;
  readonly dim: number;
  private lastFailure: number | null = null;

  constructor(host: string, cooldownMs: number = HEALTH_COOLDOWN_MS, model: string = EMBEDDING_MODEL, dim: number = VECTOR_DIM) {
    this.host = host;
    this.model = model;
    this.cooldownMs = cooldownMs;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    // Circuit breaker: if recently failed, skip network call
    if (this.lastFailure !== null) {
      const elapsed = Date.now() - this.lastFailure;
      if (elapsed < this.cooldownMs) {
        return null;
      }
    }

    for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.host}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: AbortSignal.timeout(embedTimeoutMs(texts.length)),
        });
      } catch {
        // Thrown errors (ECONNRESET, socket hang up, fetch failure, abort)
        // are treated as TRANSIENT: a crashed/restarting llama-server
        // subprocess looks exactly like this on a single request. Retry
        // with backoff before giving up and tripping the breaker.
        if (attempt < TRANSIENT_RETRY_ATTEMPTS) {
          await sleep(TRANSIENT_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        this.lastFailure = Date.now();
        return null;
      }

      if (!response.ok) {
        // 5xx is treated as TRANSIENT (server-side blip); 4xx is terminal
        // immediately (retrying a bad request/model won't help).
        if (response.status >= 500 && attempt < TRANSIENT_RETRY_ATTEMPTS) {
          await sleep(TRANSIENT_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        this.lastFailure = Date.now();
        return null;
      }

      const data = (await response.json()) as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        console.warn(
          `[project-brain] embed response length mismatch: expected ${texts.length}, received ${
            Array.isArray(data.embeddings) ? data.embeddings.length : "non-array"
          }`
        );
        this.lastFailure = Date.now();
        return null;
      }
      // Reset circuit breaker on success
      this.lastFailure = null;
      return data.embeddings;
    }

    // Unreachable (loop always returns or falls through to a return above
    // on its final attempt), but keeps the type checker happy.
    this.lastFailure = Date.now();
    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
