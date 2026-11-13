import { describe, it, expect } from "bun:test";
import { buildConceptPrompt, CONCEPT_PROMPT_MAX_CHARS } from "../../src/concept/prompt.js";

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

describe("buildConceptPrompt diff cap", () => {
  it("cuts a huge diff from the end with a marker, keeping the instructions and the prompt within the cap", () => {
    const diff = `+first line\n${"+x\n".repeat(200_000)}+last line`;
    const prompt = buildConceptPrompt({ module: "src", commitMessage: "feat: big", diff, existingDoc: "" });
    expect(prompt.length).toBeLessThanOrEqual(CONCEPT_PROMPT_MAX_CHARS);
    expect(prompt).toContain("+first line");
    expect(prompt).not.toContain("+last line");
    expect(prompt).toMatch(/\[diff truncated: last \d+ of \d+ characters omitted\]/);
    expect(prompt).toContain("Output ONLY the updated markdown");
    expect(prompt.trimEnd().endsWith("after the Gotchas section.")).toBe(true);
  });

  it("leaves a diff that fits untouched", () => {
    const prompt = buildConceptPrompt({ module: "src", commitMessage: "m", diff: "+small", existingDoc: "" });
    expect(prompt).not.toContain("diff truncated");
  });
});
