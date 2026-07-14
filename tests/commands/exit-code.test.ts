import { describe, it, expect } from "bun:test";
import { syncExitCode } from "../../src/commands/sync.js";

describe("syncExitCode", () => {
  it("returns 0 when nothing failed", () => {
    expect(syncExitCode({ embedFailed: 0 })).toBe(0);
  });

  it("returns 1 on total embed failure (error set)", () => {
    expect(syncExitCode({ embedFailed: 487, error: "Embedding failed: 0/487 vectors produced" })).toBe(1);
  });

  it("returns 1 on PARTIAL embed failure (no error, embedFailed > 0)", () => {
    expect(syncExitCode({ embedFailed: 3 })).toBe(1);
  });
});
