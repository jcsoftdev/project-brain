import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  resolveRerankerToken,
  resolveRerankerTokenWithSource,
  writeRerankerToken,
  removeRerankerToken,
  rerankerTokenPath,
} from "../../src/rerank/token.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pb-rerank-token-"));
}

describe("reranker token resolution", () => {
  it("prefers TYPESAFE_API_KEY over the file", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-token");
    const token = await resolveRerankerToken({ dataDir: dir, env: { TYPESAFE_API_KEY: "env-token" } });
    expect(token).toBe("env-token");
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the file when the env var is unset", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-token");
    const token = await resolveRerankerToken({ dataDir: dir, env: {} });
    expect(token).toBe("file-token");
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when neither the env var nor the file exist", async () => {
    const dir = await tmp();
    const token = await resolveRerankerToken({ dataDir: dir, env: {} });
    expect(token).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for an unparseable or empty-token file", async () => {
    const dir = await tmp();
    await Bun.write(rerankerTokenPath(dir), "not json");
    const token = await resolveRerankerToken({ dataDir: dir, env: {} });
    expect(token).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the token file with mode 0600", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "secret");
    const st = await stat(rerankerTokenPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  });

  it("removes the token file", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "secret");
    await removeRerankerToken(dir);
    const token = await resolveRerankerToken({ dataDir: dir, env: {} });
    expect(token).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("remove is a no-op when the file never existed", async () => {
    const dir = await tmp();
    await expect(removeRerankerToken(dir)).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("reranker token resolution with source (Jev status discoverability)", () => {
  it("reports source 'env' and the token when TYPESAFE_API_KEY wins", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-token");
    const resolved = await resolveRerankerTokenWithSource({ dataDir: dir, env: { TYPESAFE_API_KEY: "env-token" } });
    expect(resolved).toEqual({ token: "env-token", source: "env" });
    await rm(dir, { recursive: true, force: true });
  });

  it("reports source 'file' and the file path when falling back to the file", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-token");
    const resolved = await resolveRerankerTokenWithSource({ dataDir: dir, env: {} });
    expect(resolved).toEqual({ token: "file-token", source: "file", path: rerankerTokenPath(dir) });
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when neither the env var nor the file resolve a token", async () => {
    const dir = await tmp();
    const resolved = await resolveRerankerTokenWithSource({ dataDir: dir, env: {} });
    expect(resolved).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for an unparseable file, same as resolveRerankerToken", async () => {
    const dir = await tmp();
    await Bun.write(rerankerTokenPath(dir), "not json");
    const resolved = await resolveRerankerTokenWithSource({ dataDir: dir, env: {} });
    expect(resolved).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("resolveRerankerToken stays a thin wrapper (token only, no source)", async () => {
    const dir = await tmp();
    await writeRerankerToken(dir, "file-token");
    const token = await resolveRerankerToken({ dataDir: dir, env: {} });
    expect(token).toBe("file-token");
    await rm(dir, { recursive: true, force: true });
  });
});
