import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, parseHookInput, runSuggest } from "../../src/commands/suggest.js";
import { pickSuggestions } from "../../src/skills/picker.js";

const PROMPT = "haz el commit de estos cambios";
const hook = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ prompt: PROMPT, cwd: "/somewhere", hook_event_name: "UserPromptSubmit", ...over });

describe("parseHookInput", () => {
  it("reads prompt and cwd", () => {
    expect(parseHookInput(hook({ transcript_path: "/t.jsonl" }))).toEqual({ prompt: PROMPT, cwd: "/somewhere", transcriptPath: "/t.jsonl" });
  });

  it("returns an empty prompt for malformed input", () => {
    for (const raw of ["", "{bad", "[]", "42", JSON.stringify({ prompt: 3 })]) expect(parseHookInput(raw).prompt).toBe("");
  });
});

describe("runSuggest task switch", () => {
  const task = { recent: ["fix login"], usedPct: 45, pending: false, assistant: null };
  const run = async (probabilities: Record<string, number> | undefined, taskContext: any = async () => task) => {
    const printed: string[] = [];
    const asked: unknown[] = [];
    await runSuggest(hook(), {
      print: (l) => printed.push(l),
      queryEmbedding: async () => null,
      taskContext,
      pick: async (_p, deps) => {
        asked.push(deps.taskSwitch);
        if (probabilities) deps.onTaskSwitch?.(probabilities);
        return ["Suggested skill: x"];
      },
    });
    return { printed, asked };
  };

  it("shows a one-line systemMessage and keeps the suggestions as context for a confident new task", async () => {
    const { printed, asked } = await run({ new_task: 0.95, same_task: 0.05 });
    expect(asked).toEqual([{ recent: ["fix login"] }]);
    expect(printed).toHaveLength(1);
    const out = JSON.parse(printed[0]!);
    expect(out.systemMessage).toContain("/clear");
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: "Suggested skill: x" });
  });

  it("prints plain lines and asks nothing extra without task context", async () => {
    const { printed, asked } = await run(undefined, async () => null);
    expect(asked).toEqual([undefined]);
    expect(printed).toEqual(["Suggested skill: x"]);
  });

  it("prints plain lines when the verdict is none", async () => {
    expect((await run({ new_task: 0.5 })).printed).toEqual(["Suggested skill: x"]);
  });

  it("survives a failing context reader", async () => {
    const { printed } = await run(undefined, async () => {
      throw new Error("boom");
    });
    expect(printed).toEqual(["Suggested skill: x"]);
  });
});

describe("runSuggest notices", () => {
  const task = { recent: ["fix login"], usedPct: 45, pending: false, assistant: null };
  const never = () => new Promise<string[]>(() => {});

  it("shows the /clear notice once per session and kind", async () => {
    const seen = new Set<string>();
    const claimNotice = async (s: string, k: string) => !seen.has(`${s}${k}`) && !!seen.add(`${s}${k}`);
    const printed: string[] = [];
    const go = (session: string) =>
      runSuggest(hook({ session_id: session }), {
        print: (l) => printed.push(l),
        queryEmbedding: async () => null,
        taskContext: async () => task,
        claimNotice,
        pick: async (_p, deps) => (deps.onTaskSwitch?.({ new_task: 0.95 }), ["Suggested skill: x"]),
      });
    await go("s1");
    await go("s1");
    await go("s2");
    expect(printed.map((l) => l.startsWith("{"))).toEqual([true, false, true]);
  });

  it("marks the upgrade notice shown only after it is printed", async () => {
    const events: string[] = [];
    const upgradeNotice = async () => ({ text: "updated", commit: async () => void events.push("commit") });
    void runSuggest(hook(), {
      print: (l) => events.push(`print:${l}`),
      queryEmbedding: async () => null,
      taskContext: async () => null,
      upgradeNotice,
      pick: never,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["print:updated", "commit"]);
  });

  it("leaves the upgrade notice owed when a task-switch document is pending and the pick never returns", async () => {
    const events: string[] = [];
    void runSuggest(hook(), {
      print: (l) => events.push(`print:${l}`),
      queryEmbedding: async () => null,
      taskContext: async () => task,
      upgradeNotice: async () => ({ text: "updated", commit: async () => void events.push("commit") }),
      pick: never,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
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
    expect(seen).toEqual([{ prompt: PROMPT, projectDir: dir }]);
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
      embedBudgetMs: 20,
      queryEmbedding: () => new Promise(() => {}),
      pick: async (_p, deps) => ((await deps.queryEmbedding!()) === null ? ["Suggested skill: kw"] : []),
    });
    expect(printed).toEqual(["Suggested skill: kw"]);
  });

  const stubs = { discover: async () => [{ name: "brain-commit", description: "write the commit message" }], loadTools: async () => [] };

  it("never starts the embed when there is no token or both pickers are off", async () => {
    let embeds = 0;
    const queryEmbedding = async () => ((embeds += 1), null);

    await runSuggest(hook(), { queryEmbedding, pick: (p, d) => pickSuggestions(p, { ...d, ...stubs, env: {}, getToken: async () => null }) });
    await runSuggest(hook(), {
      queryEmbedding,
      pick: (p, d) => pickSuggestions(p, { ...d, ...stubs, env: { BRAIN_SKILL_PICKER: "0", BRAIN_TOOL_PICKER: "0" }, getToken: async () => "t" }),
    });
    expect(embeds).toBe(0);
  });

  it("starts the embed once, when the picker asks for it", async () => {
    let embeds = 0;
    await runSuggest(hook(), {
      queryEmbedding: async () => ((embeds += 1), null),
      pick: (p, d) =>
        pickSuggestions(p, { ...d, ...stubs, env: {}, getToken: async () => "t", fetchFn: async () => new Response("{}") }),
    });
    expect(embeds).toBe(1);
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
  it("makes no Jev request and prints no Suggested line, even with a token", async () => {
    const { execute: search } = await import("../../src/commands/search.js");
    const realFetch = globalThis.fetch;
    const realLog = console.log;
    const realKey = process.env.TYPESAFE_API_KEY;
    const calls: string[] = [];
    const logs: string[] = [];
    process.env.TYPESAFE_API_KEY = "test-token";
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}");
    }) as unknown as typeof fetch;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let retrieved = "";
    try {
      await search(["--stdin"], async () => hook(), async (q) => void (retrieved = q));
    } finally {
      globalThis.fetch = realFetch;
      console.log = realLog;
      if (realKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = realKey;
    }
    expect(retrieved).toBe(PROMPT);
    expect(calls).toEqual([]);
    expect(logs.filter((l) => l.includes("Suggested"))).toEqual([]);
  });
});
