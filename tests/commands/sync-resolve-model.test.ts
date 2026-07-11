import { describe, it, expect } from "bun:test";
import { resolveSyncModel } from "../../src/commands/sync.js";

describe("resolveSyncModel", () => {
  it("returns the env override when set, even if stored meta says a different model", () => {
    const result = resolveSyncModel({
      envModel: "qwen3-embedding",
      storedMeta: { model: "nomic-embed-text", dim: 768 },
    });
    expect(result).toBe("qwen3-embedding");
  });

  it("returns the stored meta model when no env override is set", () => {
    const result = resolveSyncModel({
      envModel: undefined,
      storedMeta: { model: "nomic-embed-text", dim: 768 },
    });
    expect(result).toBe("nomic-embed-text");
  });

  it("returns undefined when neither env nor stored meta is present (registry default applies downstream)", () => {
    const result = resolveSyncModel({
      envModel: undefined,
      storedMeta: null,
    });
    expect(result).toBeUndefined();
  });

  it("returns the env override when set and there is no stored meta yet (fresh project + explicit override)", () => {
    const result = resolveSyncModel({
      envModel: "nomic-embed-text",
      storedMeta: null,
    });
    expect(result).toBe("nomic-embed-text");
  });
});
