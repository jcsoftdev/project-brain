import { describe, it, expect } from "bun:test";
import { computeHash } from "../../src/indexer/hash.js";

describe("computeHash", () => {
  it("returns hex-encoded SHA-256 hash", () => {
    const hash = computeHash("hello world");
    // Known SHA-256 of "hello world"
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
  });

  it("is deterministic (same content → same hash)", () => {
    const a = computeHash("test content");
    const b = computeHash("test content");
    expect(a).toBe(b);
  });

  it("different content → different hash", () => {
    const a = computeHash("content A");
    const b = computeHash("content B");
    expect(a).not.toBe(b);
  });

  it("returns 64-character hex string", () => {
    const hash = computeHash("anything");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });
});
