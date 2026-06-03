import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHttpServer, type HttpServerHandle } from "../src/server-http.js";

/**
 * HTTP round-trip integration: binds a real ephemeral port and drives the
 * bearer-auth middleware end-to-end (not just the pure authorize() helper).
 * No Ollama needed — auth runs before any embedding work, so the middleware
 * is exercised regardless of the embedding backend.
 */
describe("createHttpServer — HTTP round-trip auth (integration)", () => {
  let tempDir: string;
  let handle: HttpServerHandle | null = null;
  const TOKEN = "integration-secret-token";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-http-"));
    handle = await createHttpServer({ port: 0, token: TOKEN, dbPath: tempDir });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  function url(): string {
    return `http://localhost:${handle!.port}/`;
  }

  it("binds a real, non-zero ephemeral port", () => {
    expect(handle!.port).toBeGreaterThan(0);
  });

  it("rejects a request with no Authorization header (401)", async () => {
    const res = await fetch(url(), { method: "POST" });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("rejects a request with the wrong bearer token (401)", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("passes auth with the correct bearer token (not 401)", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    // Auth middleware let it through — the transport handled it (status is not 401).
    expect(res.status).not.toBe(401);
    await res.body?.cancel();
  });
});
