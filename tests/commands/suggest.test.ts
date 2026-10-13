import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, parseHookInput, runSuggest } from "../../src/commands/suggest.js";

const hook = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ prompt: "haz el commit de estos cambios", cwd: "/somewhere", hook_event_name: "UserPromptSubmit", ...over });

describe("parseHookInput", () => {
  it("reads prompt and cwd", () => {
    expect(parseHookInput(hook())).toEqual({ prompt: "haz el commit de estos cambios", cwd: "/somewhere" });
  });

  it("returns an empty prompt for malformed input", () => {
    for (const raw of ["", "{bad", "[]", "42", JSON.stringify({ prompt: 3 })]) expect(parseHookInput(raw).prompt).toBe("");
  });
});

describe("runSuggest", () => {
  it("prints the picker's lines for a directory with no project-brain at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-suggest-"));
    const printed: string[] = [];
    const seen: Array<{ prompt: string; projectDir: string }> = [];
    await runSuggest(hook({ cwd: dir }), {
      print: (l) => printed.push(l),
      queryEmbedding: async () => null,
      pick: async (prompt, deps) => {
        seen.push({ prompt, projectDir: deps.projectDir });
        return ["Suggested skill: brain-commit — x", "Suggested tool: mcp__slack__send — y"];
      },
    });
    expect(printed).toEqual(["Suggested skill: brain-commit — x", "Suggested tool: mcp__slack__send — y"]);
    expect(seen).toEqual([{ prompt: "haz el commit de estos cambios", projectDir: dir }]);
  });

  it("skips trivial prompts without calling the picker", async () => {
    let called = false;
    await runSuggest(hook({ prompt: "ok" }), { pick: async () => ((called = true), []) });
    expect(called).toBe(false);
  });

  it("falls back to no vector when the embed hangs, and still picks", async () => {
    const printed: string[] = [];
    await runSuggest(hook(), {
      print: (l) => printed.push(l),
      queryEmbedding: () => new Promise(() => {}),
      pick: async (_p, deps) => ((await deps.queryEmbedding!()) === null ? ["Suggested skill: kw"] : []),
    });
    expect(printed).toEqual(["Suggested skill: kw"]);
  });

  it("prints nothing and does not throw when the picker throws", async () => {
    const printed: string[] = [];
    await expect(
      runSuggest(hook(), {
        print: (l) => printed.push(l),
        pick: async () => {
          throw new Error("boom");
        },
      })
    ).resolves.toBeUndefined();
    expect(printed).toEqual([]);
  });
});

describe("execute", () => {
  it("does nothing without --stdin", async () => {
    let read = false;
    await execute([], async () => ((read = true), ""));
    expect(read).toBe(false);
  });

  it("swallows a failing stdin read", async () => {
    await expect(execute(["--stdin"], async () => Promise.reject(new Error("x")))).resolves.toBeUndefined();
  });
});

describe("search --stdin no longer suggests", () => {
  it("search.ts does not reach the pickers", async () => {
    const src = await readFile(join(import.meta.dir, "../../src/commands/search.ts"), "utf-8");
    expect(src).not.toContain("pickSuggestions");
    expect(src).not.toContain("skills/picker");
  });
});
