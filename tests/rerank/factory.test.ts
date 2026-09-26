import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createReranker, createRerankerWithSource } from "../../src/rerank/factory.js";
import { writeRerankerToken } from "../../src/rerank/token.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pb-rerank-factory-"));
}

describe("createRerankerWithSource", () => {
  it("returns null when no token resolves (opt-out, zero network calls)", async () => {
    const dir = await tmp();
    const result = await createRerankerWithSource({ dataDir: dir, env: {} });
    expect(result).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a reranker plus source 'env' when TYPESAFE_API_KEY is set", async () => {
    const dir = await tmp();
    const result = await createRerankerWithSource({ dataDir: dir, env: { TYPESAFE_API_KEY: "tok" } });
    expect(result?.source).toBe("env");
    expect(result?.path).toBeUndefined();
    expect(typeof result?.reranker.rerank).toBe("function");
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a reranker plus source 'file' and the file path when reading from the token file", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-tok");
    const result = await createRerankerWithSource({ dataDir: dir, env: {} });
    expect(result?.source).toBe("file");
    expect(result?.path).toContain("reranker.json");
    await rm(dir, { recursive: true, force: true });
  });

  it("createReranker stays a thin wrapper returning just the reranker", async () => {
    const dir = await tmp();
    const reranker = await createReranker({ dataDir: dir, env: { TYPESAFE_API_KEY: "tok" } });
    expect(typeof reranker?.rerank).toBe("function");
    await rm(dir, { recursive: true, force: true });
  });
});
