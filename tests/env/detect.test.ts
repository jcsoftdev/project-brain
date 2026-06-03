import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// We test by calling the function and checking return values.
// For Ollama we mock global fetch; for AI tools we test the shape.

describe("detectEnvironment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns bun version, platform, and arch", async () => {
    // Mock fetch so Ollama ping fails (isolate)
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    expect(env.bun).toBe(Bun.version);
    expect(env.platform).toBe(process.platform);
    expect(env.arch).toBe(process.arch);
  });

  it("ollama available: true when fetch succeeds with models", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ models: [{ name: "nomic-embed-text" }] }),
          { status: 200 }
        )
      )
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    expect(env.ollama.available).toBe(true);
    expect(env.ollama.models).toContain("nomic-embed-text");
  });

  it("ollama available: false when fetch rejects", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNREFUSED"))
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    expect(env.ollama.available).toBe(false);
    expect(env.ollama.models).toEqual([]);
  });

  it("ollama available: false when fetch times out (AbortError)", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException("The operation was aborted", "AbortError"))
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    expect(env.ollama.available).toBe(false);
  });

  it("returns aiTools array", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("no ollama"))
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    expect(Array.isArray(env.aiTools)).toBe(true);
    // Should have entries for known tools
    const names = env.aiTools.map((t) => t.name);
    expect(names).toContain("Claude Code");
    expect(names).toContain("Codex");
    expect(names).toContain("Gemini CLI");
    expect(names).toContain("Cursor");
  });

  it("aiTools have correct shape", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("no ollama"))
    ) as any;

    const { detectEnvironment } = await import("../../src/env/detect.js");
    const env = await detectEnvironment();

    for (const tool of env.aiTools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("installed");
      expect(typeof tool.installed).toBe("boolean");
      expect(tool).toHaveProperty("configPath");
    }
  });
});
