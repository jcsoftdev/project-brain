import { describe, it, expect } from "bun:test";
import { worktreeGuardDecision } from "../../src/hooks/worktree-guard.js";

const MAIN = { isMain: true, inRepo: true };
const WORKTREE = { isMain: false, inRepo: true };

function spawn(fields: Record<string, unknown>, tool = "Agent") {
  return { tool_name: tool, tool_input: fields };
}

describe("worktreeGuardDecision", () => {
  it("blocks a delegation from the main checkout that never mentions isolation", () => {
    const d = worktreeGuardDecision(spawn({ description: "fix the login bug" }), MAIN);
    expect(d.block).toBe(true);
  });

  it("tells the model exactly how to satisfy it", () => {
    const d = worktreeGuardDecision(spawn({ description: "fix the login bug" }), MAIN);
    expect(d.reason).toContain("worktree");
    expect(d.reason).toContain("brain-worktree");
  });

  it("allows once the description addresses isolation", () => {
    const d = worktreeGuardDecision(
      spawn({ description: "read-only audit, no worktree needed" }),
      MAIN
    );
    expect(d.block).toBe(false);
  });

  it("accepts the acknowledgement in the prompt as well as the description", () => {
    const d = worktreeGuardDecision(
      spawn({ description: "implement checkout", prompt: "Work in the worktree at wt-a." }),
      MAIN
    );
    expect(d.block).toBe(false);
  });

  it("is case-insensitive about the acknowledgement", () => {
    const d = worktreeGuardDecision(spawn({ description: "no Worktree required" }), MAIN);
    expect(d.block).toBe(false);
  });

  it("never fires once the session is already inside a worktree", () => {
    // The decision has been made. Asking again is pure friction.
    const d = worktreeGuardDecision(spawn({ description: "fix the login bug" }), WORKTREE);
    expect(d.block).toBe(false);
  });

  it("never fires outside a git repository", () => {
    const d = worktreeGuardDecision(spawn({ description: "fix it" }), {
      isMain: true,
      inRepo: false,
    });
    expect(d.block).toBe(false);
  });

  it("guards both spellings of the spawn tool", () => {
    expect(worktreeGuardDecision(spawn({ description: "x" }, "Task"), MAIN).block).toBe(true);
    expect(worktreeGuardDecision(spawn({ description: "x" }, "Agent"), MAIN).block).toBe(true);
  });

  it("ignores every tool that does not spawn an agent", () => {
    expect(worktreeGuardDecision(spawn({ description: "x" }, "Read"), MAIN).block).toBe(false);
    expect(worktreeGuardDecision(spawn({ description: "x" }, "Bash"), MAIN).block).toBe(false);
  });

  it("fails open on a payload it cannot read", () => {
    // A guard that blocks because it could not parse its own input breaks
    // delegation entirely, and the only fix a user has is to uninstall it.
    expect(worktreeGuardDecision(null, MAIN).block).toBe(false);
    expect(worktreeGuardDecision("nonsense", MAIN).block).toBe(false);
    expect(worktreeGuardDecision({ tool_name: "Agent" }, MAIN).block).toBe(false);
    expect(worktreeGuardDecision({ tool_name: 7, tool_input: {} }, MAIN).block).toBe(false);
  });

  it("blocks a spawn whose fields are present but empty", () => {
    const d = worktreeGuardDecision(spawn({ description: "", prompt: "" }), MAIN);
    expect(d.block).toBe(true);
  });
});
