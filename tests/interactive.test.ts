import { describe, it, expect } from "bun:test";
import { promptModelRouting } from "../src/interactive.js";

describe("promptModelRouting", () => {
  it("resolves false immediately in a non-interactive session (no stdout TTY, as in bun test/CI)", async () => {
    // process.stdout.isTTY is falsy under bun test, so the TTY guard short-circuits
    // before any @clack/prompts stdin read — safe to call directly, cannot hang.
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    const result = await promptModelRouting();
    expect(result).toBe(false);
  });
});
