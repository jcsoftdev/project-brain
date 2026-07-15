import { describe, it, expect } from "bun:test";
import { buildConceptPrompt } from "../../src/concept/prompt.js";

describe("buildConceptPrompt", () => {
  it("includes the module name, commit message, diff, and existing doc", () => {
    const prompt = buildConceptPrompt({
      module: "auth",
      commitMessage: "feat(auth): add login",
      diff: "+export function login() {}",
      existingDoc: "## Purpose\n\nNone yet.",
    });
    expect(prompt).toContain("auth");
    expect(prompt).toContain("feat(auth): add login");
    expect(prompt).toContain("export function login");
    expect(prompt).toContain("## Purpose");
    expect(prompt).toContain("## Key Files");
    expect(prompt).toContain("## Dependencies");
    expect(prompt).toContain("## Data Flow");
    expect(prompt).toContain("## Gotchas");
  });

  it("marks a missing existing doc explicitly", () => {
    const prompt = buildConceptPrompt({
      module: "auth",
      commitMessage: "feat(auth): add login",
      diff: "+export function login() {}",
      existingDoc: "",
    });
    expect(prompt).toContain("(none yet)");
  });
});
