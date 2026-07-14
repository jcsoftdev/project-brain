import { describe, it, expect } from "bun:test";
import { EmbeddingPool } from "../../src/embeddings/pool.js";

const okClient = (tag: number, log: number[]) => ({
  model: "m", dim: 3,
  async embed(texts: string[]) { log.push(tag); return texts.map(() => [tag, tag, tag]); },
  async isAvailable() { return true; },
  reset() {},
});
const deadClient = (tag: number, log: number[]) => ({
  model: "m", dim: 3,
  async embed(_texts: string[]) { log.push(tag); return null; },
  async isAvailable() { return false; },
  reset() {},
});

describe("EmbeddingPool", () => {
  it("round-robins across healthy clients", async () => {
    const log: number[] = [];
    const pool = new EmbeddingPool([okClient(1, log), okClient(2, log)]);
    await pool.embed(["a"]);
    await pool.embed(["b"]);
    await pool.embed(["c"]);
    expect(log).toEqual([1, 2, 1]);
  });

  it("falls through to the next client when one returns null", async () => {
    const log: number[] = [];
    const pool = new EmbeddingPool([deadClient(1, log), okClient(2, log)]);
    expect(await pool.embed(["a"])).toEqual([[2, 2, 2]]);
    expect(log).toEqual([1, 2]);
  });

  it("returns null only when ALL clients fail", async () => {
    const log: number[] = [];
    const pool = new EmbeddingPool([deadClient(1, log), deadClient(2, log)]);
    expect(await pool.embed(["a"])).toBeNull();
    expect(log).toEqual([1, 2]);
  });

  it("proxies model/dim from the first client", () => {
    const pool = new EmbeddingPool([okClient(1, []), okClient(2, [])] as any);
    expect(pool.model).toBe("m");
    expect(pool.dim).toBe(3);
  });

  it("reset() resets all clients", () => {
    let resetCount = 0;
    const client = () => ({
      model: "m", dim: 3,
      async embed() { return null; },
      async isAvailable() { return true; },
      reset() { resetCount++; },
    });
    const pool = new EmbeddingPool([client(), client()] as any);
    pool.reset();
    expect(resetCount).toBe(2);
  });

  it("throws when constructed with zero clients", () => {
    expect(() => new EmbeddingPool([])).toThrow();
  });
});
