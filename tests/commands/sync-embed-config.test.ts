import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolveEmbedConfig } from "../../src/commands/sync.js";

describe("resolveEmbedConfig", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  describe("defaults", () => {
    it("returns batchSize=64, concurrency=1 when env vars are unset", () => {
      const config = resolveEmbedConfig({});
      expect(config.batchSize).toBe(64);
      expect(config.concurrency).toBe(1);
    });
  });

  describe("valid overrides", () => {
    it("parses a valid BRAIN_EMBED_BATCH_SIZE", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "16" });
      expect(config.batchSize).toBe(16);
    });

    it("parses a valid BRAIN_EMBED_CONCURRENCY", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_CONCURRENCY: "1" });
      expect(config.concurrency).toBe(1);
    });

    it("parses both overrides together", () => {
      const config = resolveEmbedConfig({
        BRAIN_EMBED_BATCH_SIZE: "128",
        BRAIN_EMBED_CONCURRENCY: "8",
      });
      expect(config.batchSize).toBe(128);
      expect(config.concurrency).toBe(8);
    });
  });

  describe("clamping out-of-range values", () => {
    it("clamps batchSize below 1 up to 1", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "0" });
      expect(config.batchSize).toBe(1);
    });

    it("clamps negative batchSize up to 1", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "-5" });
      expect(config.batchSize).toBe(1);
    });

    it("clamps batchSize above 512 down to 512", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "9999" });
      expect(config.batchSize).toBe(512);
    });

    it("clamps concurrency below 1 up to 1", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_CONCURRENCY: "0" });
      expect(config.concurrency).toBe(1);
    });

    it("clamps concurrency above 16 down to 16", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_CONCURRENCY: "100" });
      expect(config.concurrency).toBe(16);
    });
  });

  describe("garbage/empty input falls back to default with a warning", () => {
    it("falls back on non-numeric BRAIN_EMBED_BATCH_SIZE", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "abc" });
      expect(config.batchSize).toBe(64);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("falls back on empty-string BRAIN_EMBED_BATCH_SIZE", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "" });
      expect(config.batchSize).toBe(64);
    });

    it("falls back on non-numeric BRAIN_EMBED_CONCURRENCY", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_CONCURRENCY: "xyz" });
      expect(config.concurrency).toBe(1);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("falls back on a float string (non-integer)", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "3.5" });
      expect(config.batchSize).toBe(64);
    });

    it("falls back on NaN-producing input like whitespace", () => {
      const config = resolveEmbedConfig({ BRAIN_EMBED_BATCH_SIZE: "   " });
      expect(config.batchSize).toBe(64);
    });
  });

  describe("defaults to process.env when no env argument is passed", () => {
    it("reads BRAIN_EMBED_BATCH_SIZE from process.env", () => {
      const prev = process.env.BRAIN_EMBED_BATCH_SIZE;
      process.env.BRAIN_EMBED_BATCH_SIZE = "32";
      try {
        const config = resolveEmbedConfig();
        expect(config.batchSize).toBe(32);
      } finally {
        if (prev === undefined) delete process.env.BRAIN_EMBED_BATCH_SIZE;
        else process.env.BRAIN_EMBED_BATCH_SIZE = prev;
      }
    });
  });
});
