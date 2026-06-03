import { EMBEDDING_MODEL, HEALTH_COOLDOWN_MS, VECTOR_DIM } from "../constants.js";
import type { EmbeddingClient } from "../types.js";

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
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.lastFailure = Date.now();
        return null;
      }

      const data = (await response.json()) as { embeddings: number[][] };
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
