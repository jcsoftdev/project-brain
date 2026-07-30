import { describe, it, expect } from "bun:test";
import { promptModelRouting, promptSkillInstall } from "../src/interactive.js";

describe("promptModelRouting", () => {
  it("resolves false immediately in a non-interactive session (no stdout TTY, as in bun test/CI)", async () => {
    // process.stdout.isTTY is falsy under bun test, so the TTY guard short-circuits
    // before any @clack/prompts stdin read — safe to call directly, cannot hang.
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    const result = await promptModelRouting();
    expect(result).toBe(false);
  });
});

describe("promptSkillInstall", () => {
  /**
   * The inverse default of promptModelRouting, and the whole point of this
   * function existing separately: the skill is part of what setup delivers, so
   * a scripted install gets it. Only --no-brain-audit opts out.
   */
  it("resolves TRUE in a non-interactive session (opposite of promptModelRouting)", async () => {
    expect(Boolean(process.stdout.isTTY)).toBe(false);
    expect(await promptSkillInstall()).toBe(true);
  });

  it("resolves true under CI without reading stdin, even with both streams TTY", async () => {
    const outTTY = process.stdout.isTTY;
    const inTTY = process.stdin.isTTY;
    const ci = process.env.CI;
    try {
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      process.env.CI = "1";
      // If the CI guard regressed this would block on @clack/prompts forever,
      // so a hang here is the failure signal as much as a wrong value is.
      expect(await promptSkillInstall()).toBe(true);
    } finally {
      process.stdout.isTTY = outTTY;
      process.stdin.isTTY = inTTY;
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
    }
  });
});
