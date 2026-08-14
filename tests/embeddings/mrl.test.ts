import { describe, it, expect } from "bun:test";
import {
  supportsMrl,
  nativeDimFor,
  truncateAndNormalize,
  resolveEmbedDim,
} from "../../src/embeddings/mrl.js";

const l2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("supportsMrl", () => {
  it("recognises the Matryoshka-trained models we ship with", () => {
    expect(supportsMrl("qwen3-embedding:0.6b")).toBe(true);
    expect(supportsMrl("nomic-embed-text")).toBe(true);
    expect(supportsMrl("nomic-embed-text:latest")).toBe(true);
  });

  it("refuses anything not known to be Matryoshka-trained", () => {
    // Truncating a non-MRL model is not a smaller embedding, it is a broken
    // one: its information is spread across all dimensions, so a prefix is
    // noise. Silence here would degrade retrieval invisibly.
    expect(supportsMrl("mystery-embed")).toBe(false);
    expect(supportsMrl("all-minilm")).toBe(false);
  });

  it("reports the native dimension of a known model", () => {
    expect(nativeDimFor("qwen3-embedding:0.6b")).toBe(1024);
    expect(nativeDimFor("nomic-embed-text")).toBe(768);
    expect(nativeDimFor("mystery-embed")).toBeNull();
  });
});

describe("truncateAndNormalize", () => {
  it("returns a vector of the requested length", () => {
    const v = Array.from({ length: 1024 }, (_, i) => i + 1);
    expect(truncateAndNormalize(v, 512)).toHaveLength(512);
  });

  it("re-normalizes to unit length", () => {
    // A prefix of a unit vector is NOT a unit vector, and cosine similarity
    // assumes magnitude 1. Skipping this silently distorts every score.
    const v = Array.from({ length: 8 }, (_, i) => i + 1);
    expect(l2(truncateAndNormalize(v, 4))).toBeCloseTo(1, 10);
  });

  it("preserves the direction of the kept prefix", () => {
    const v = [3, 4, 99, 99];
    const out = truncateAndNormalize(v, 2);
    // 3-4-5 triangle: direction preserved, magnitude scaled to 1.
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
  });

  it("leaves a full-length vector untouched", () => {
    const v = [0.6, 0.8];
    expect(truncateAndNormalize(v, 2)).toEqual(v);
  });

  it("throws when asked for more dimensions than exist", () => {
    expect(() => truncateAndNormalize([1, 2, 3], 8)).toThrow();
  });

  it("returns the zero-prefix unchanged rather than dividing by zero", () => {
    const out = truncateAndNormalize([0, 0, 5, 5], 2);
    expect(out).toEqual([0, 0]);
  });
});

describe("resolveEmbedDim", () => {
  it("uses the model's native width when nothing is requested", () => {
    expect(resolveEmbedDim("qwen3-embedding:0.6b", 1024, undefined)).toBe(1024);
  });

  it("honours a smaller request for an MRL model", () => {
    expect(resolveEmbedDim("qwen3-embedding:0.6b", 1024, "512")).toBe(512);
    expect(resolveEmbedDim("nomic-embed-text", 768, "256")).toBe(256);
  });

  it("ignores a request for a model that is not Matryoshka-trained", () => {
    // Falling back to native is the safe failure: a smaller-but-broken index
    // costs more than the disk it saves.
    expect(resolveEmbedDim("mystery-embed", 1024, "512")).toBe(1024);
  });

  it("ignores a request wider than the model produces", () => {
    expect(resolveEmbedDim("nomic-embed-text", 768, "1536")).toBe(768);
  });

  it("ignores junk and non-positive values", () => {
    expect(resolveEmbedDim("qwen3-embedding:0.6b", 1024, "abc")).toBe(1024);
    expect(resolveEmbedDim("qwen3-embedding:0.6b", 1024, "0")).toBe(1024);
    expect(resolveEmbedDim("qwen3-embedding:0.6b", 1024, "-8")).toBe(1024);
  });
});
