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

    try {
      const response = await fetch(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(embedTimeoutMs(texts.length)),
      });

      if (!response.ok) {
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
    } catch {
      this.lastFailure = Date.now();
      return null;
    }
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
