import type { EmbeddingClient } from "../types.js";

/**
 * Round-robin pool over N EmbeddingClients (one per Ollama host). A null
 * from one client (its breaker open, its llama-server crashed) falls
 * through to the next; the pool only returns null when every host failed.
 * Throughput scales with host count; reliability scales with independence
 * of failure (separate processes / machines).
 */
export class EmbeddingPool implements EmbeddingClient {
  private next = 0;
  readonly model?: string;
  readonly dim: number;

  constructor(private readonly clients: EmbeddingClient[]) {
    if (clients.length === 0) throw new Error("EmbeddingPool needs at least one client");
    // Proxy model/dim from the first client — assigned here (not as getters)
    // since EmbeddingClient declares them as readonly value properties.
    this.model = clients[0].model;
    this.dim = clients[0].dim;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    for (let i = 0; i < this.clients.length; i++) {
      const client = this.clients[(this.next + i) % this.clients.length];
      const result = await client.embed(texts);
      if (result) {
        this.next = (this.next + i + 1) % this.clients.length;
        return result;
      }
    }
    this.next = (this.next + 1) % this.clients.length;
    return null;
  }

  async isAvailable(): Promise<boolean> {
    for (const client of this.clients) {
      if (await client.isAvailable()) return true;
    }
    return false;
  }

  reset(): void {
    for (const c of this.clients) c.reset?.();
  }
}
