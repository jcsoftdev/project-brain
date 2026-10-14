import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimNotice,
  contextTokens,
  contextWindow,
  decideTaskSwitch,
  extractRecentPrompts,
  focusHint,
  hasPendingWork,
  lastAssistantSummary,
  gatherTaskContext,
  taskSwitchMessage,
  type TaskSwitchVerdict,
  thresholdsFrom,
} from "../../src/hooks/task-switch.js";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "transcript-tail.jsonl");
const entries = async () => {
  const lines = (await Bun.file(FIXTURE).text()).split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return lines;
};

describe("transcript parsing", () => {
  it("sums input, cache creation and cache reads of the latest assistant message", async () => {
    expect(contextTokens(await entries())).toBe(60_003);
  });

  it("extracts only typed prompts: no tool results, meta, sidechain or slash-command echoes", async () => {
    expect(extractRecentPrompts(await entries())).toEqual(["fix the login redirect bug", "now add a test for it", "write the quarterly report"]);
    expect(extractRecentPrompts(await entries(), 2)).toEqual(["now add a test for it", "write the quarterly report"]);
  });

  it("has no usage without an assistant message", () => {
    expect(contextTokens([{ type: "user", message: { content: "hi" } }])).toBeNull();
  });
});

describe("contextWindow", () => {
  it("prefers the env override, then the auto-compact window, then 200K", () => {
    expect(contextWindow(1000, { PROJECT_BRAIN_CONTEXT_WINDOW: "500000" }, 400_000)).toBe(500_000);
    expect(contextWindow(1000, {}, 400_000)).toBe(400_000);
    expect(contextWindow(1000, {})).toBe(200_000);
  });

  it("assumes a 1M window once usage passes the configured one", () => {
    expect(contextWindow(250_000, {})).toBe(1_000_000);
  });
});

describe("decideTaskSwitch", () => {
  const t = thresholdsFrom({});
  it("notices a confident new task above the threshold", () => {
    expect(decideTaskSwitch(40, { new_task: 0.9, same_task: 0.1 }, t)).toBe("clear");
  });
  it("stays silent below the threshold or when unsure", () => {
    expect(decideTaskSwitch(20, { new_task: 0.99 }, t)).toBe("none");
    expect(decideTaskSwitch(40, { new_task: 0.6 }, t)).toBe("none");
    expect(decideTaskSwitch(40, undefined, t)).toBe("none");
  });
  it("suggests /compact for a continuation near the limit only", () => {
    expect(decideTaskSwitch(80, { new_task: 0.1 }, t)).toBe("compact");
    expect(decideTaskSwitch(50, { new_task: 0.1 }, t)).toBe("none");
  });
  it("reads thresholds from env and ignores junk", () => {
    expect(thresholdsFrom({ PROJECT_BRAIN_TASK_SWITCH_PCT: "10", PROJECT_BRAIN_COMPACT_PCT: "x" })).toMatchObject({ noticePct: 10, compactPct: 75 });
  });
  it("words the notices on one line", () => {
    expect(taskSwitchMessage("clear", 41.6)).toContain("/clear");
    expect(taskSwitchMessage("compact", 80)).toContain("/compact");
    expect(taskSwitchMessage("none", 80)).toBeNull();
  });
});

describe("gatherTaskContext", () => {
  const noSettings = async () => undefined;
  it("returns recent prompts without the new one and the used percentage", async () => {
    const ctx = await gatherTaskContext(FIXTURE, "write the quarterly report", { PROJECT_BRAIN_CONTEXT_WINDOW: "100000" }, noSettings);
    expect(ctx?.recent).toEqual(["fix the login redirect bug", "now add a test for it"]);
    expect(Math.round(ctx!.usedPct)).toBe(60);
  });
  it("is null under the threshold, when disabled, or without a readable transcript", async () => {
    expect(await gatherTaskContext(FIXTURE, "p", { PROJECT_BRAIN_CONTEXT_WINDOW: "1000000" }, noSettings)).toBeNull();
    expect(await gatherTaskContext(FIXTURE, "p", { PROJECT_BRAIN_TASK_SWITCH: "0", PROJECT_BRAIN_CONTEXT_WINDOW: "100000" }, noSettings)).toBeNull();
    expect(await gatherTaskContext(join(await mkdtemp(join(tmpdir(), "pb-ts-")), "missing.jsonl"), "p", {}, noSettings)).toBeNull();
    expect(await gatherTaskContext(undefined, "p", {}, noSettings)).toBeNull();
  });
  it("reads only the tail of a large transcript", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "pb-ts-")), "t.jsonl");
    const filler = `${JSON.stringify({ type: "user", message: { content: "old ".repeat(50) } })}\n`.repeat(5000);
    await writeFile(file, filler + (await Bun.file(FIXTURE).text()));
    const ctx = await gatherTaskContext(file, "x", { PROJECT_BRAIN_CONTEXT_WINDOW: "100000" }, noSettings);
    expect(ctx?.recent).toHaveLength(4);
  });
});

describe("claimNotice", () => {
  it("is true once per session and kind, on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-notice-"));
    expect(await claimNotice(dir, "s/1", "clear")).toBe(true);
    expect(await claimNotice(dir, "s/1", "clear")).toBe(false);
    expect(await claimNotice(dir, "s/1", "compact")).toBe(true);
    expect(await claimNotice(dir, "s/2", "clear")).toBe(true);
  });
});

const asst = (blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });
const userResult = (id: string, content: unknown, toolUseResult?: unknown) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  ...(toolUseResult ? { toolUseResult } : {}),
});
const notification = (id: string, toolUseId: string, status: string) => ({
  type: "user",
  message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>` },
});

describe("hasPendingWork", () => {
  const launchAgent = [
    asst([{ type: "tool_use", id: "t1", name: "Agent", input: { run_in_background: true } }]),
    userResult("t1", "Async agent launched", { isAsync: true, status: "async_launched", agentId: "a1" }),
  ];

  it("is true while a background agent has not reported back, false once its notification arrives", () => {
    expect(hasPendingWork(launchAgent)).toBe(true);
    expect(hasPendingWork([...launchAgent, notification("a1", "t1", "running")])).toBe(true);
    expect(hasPendingWork([...launchAgent, notification("a1", "t1", "completed")])).toBe(false);
    expect(hasPendingWork([...launchAgent, { type: "queue-operation", operation: "enqueue", content: notification("a1", "t1", "failed").message.content }])).toBe(false);
  });

  it("matches the notification on the task id alone, and a TaskStop call ends the task", () => {
    const byTask = { type: "user", message: { content: "<task-notification><task-id>a1</task-id><status>stopped</status></task-notification>" } };
    expect(hasPendingWork([...launchAgent, byTask])).toBe(false);
    const stop = asst([{ type: "tool_use", id: "t9", name: "TaskStop", input: { task_id: "a1" } }]);
    expect(hasPendingWork([...launchAgent, stop, userResult("t9", "stopped")])).toBe(false);
  });

  it("tracks background shell commands by their result marker", () => {
    const bash = [
      asst([{ type: "tool_use", id: "b1", name: "Bash", input: { run_in_background: true } }]),
      userResult("b1", "Command running in background with ID: x1.", { backgroundTaskId: "x1" }),
    ];
    expect(hasPendingWork(bash)).toBe(true);
    expect(hasPendingWork([...bash, notification("x1", "b1", "killed")])).toBe(false);
  });

  it("treats a tool call without its result as in flight, and a finished one as done", () => {
    const call = asst([{ type: "tool_use", id: "c1", name: "Read", input: {} }]);
    expect(hasPendingWork([call])).toBe(true);
    expect(hasPendingWork([call, userResult("c1", "ok")])).toBe(false);
  });

  it("ignores sub-agent traffic", () => {
    expect(hasPendingWork([{ ...asst([{ type: "tool_use", id: "s1", name: "Read", input: {} }]), isSidechain: true }])).toBe(false);
  });
});

describe("lastAssistantSummary", () => {
  it("keeps the last text cut to 400 chars and the last tool names, without inputs", () => {
    const long = "x".repeat(900);
    const summary = lastAssistantSummary([
      asst([{ type: "tool_use", id: "1", name: "Grep", input: { pattern: "secret" } }]),
      asst([{ type: "text", text: long }, { type: "tool_use", id: "2", name: "Edit", input: { file_path: "/a" } }]),
    ])!;
    expect(summary.text.length).toBeLessThanOrEqual(400);
    expect(summary.tools).toEqual(["Grep", "Edit"]);
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("is null before the assistant has said or done anything", () => {
    expect(lastAssistantSummary([{ type: "user", message: { content: "hi" } }])).toBeNull();
  });
});

describe("gatherTaskContext summary", () => {
  const write = async (tokens: number) => {
    const dir = await mkdtemp(join(tmpdir(), "pb-ts-"));
    const file = join(dir, "t.jsonl");
    await writeFile(
      file,
      [
        { type: "user", message: { content: "fix the parser" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Parser fixed." }], usage: { input_tokens: tokens } } },
      ].map((l) => JSON.stringify(l)).join("\n")
    );
    return file;
  };

  it("carries the assistant summary and pending flag above the threshold, and nothing below it", async () => {
    const above = await gatherTaskContext(await write(100_000), "next", {}, async () => undefined);
    expect(above?.assistant?.text).toBe("Parser fixed.");
    expect(above?.pending).toBe(false);
    expect(await gatherTaskContext(await write(10_000), "next", {}, async () => undefined)).toBeNull();
  });
});

describe("three-way verdict", () => {
  const t = thresholdsFrom({});
  const table: Array<[string, number, Record<string, number>, boolean, TaskSwitchVerdict]> = [
    ["confident new task", 50, { new_task: 0.9, related_task: 0.05, same_task: 0.05 }, false, "clear"],
    ["new task while work is in flight, below compact", 50, { new_task: 0.9, related_task: 0.05, same_task: 0.05 }, true, "none"],
    ["new task while work is in flight, over compact", 80, { new_task: 0.9, related_task: 0.05, same_task: 0.05 }, true, "compact"],
    ["related task is the argmax at 0.6", 40, { new_task: 0.2, related_task: 0.6, same_task: 0.2 }, false, "compact-focus"],
    ["related task below 0.6", 40, { new_task: 0.3, related_task: 0.45, same_task: 0.25 }, false, "none"],
    ["related task while work is in flight still compacts", 40, { new_task: 0.1, related_task: 0.8, same_task: 0.1 }, true, "compact-focus"],
    ["same task under the compact threshold", 50, { new_task: 0.05, related_task: 0.05, same_task: 0.9 }, false, "none"],
    ["same task over the compact threshold", 80, { new_task: 0.05, related_task: 0.05, same_task: 0.9 }, false, "compact"],
    ["under the notice threshold", 10, { new_task: 0.99, related_task: 0, same_task: 0.01 }, false, "none"],
  ];
  for (const [name, used, probs, pending, expected] of table)
    it(name, () => expect(decideTaskSwitch(used, probs, t, pending)).toBe(expected));

  it("words the focus notice with the sanitized prompt opening", () => {
    expect(taskSwitchMessage("compact-focus", 45, "migrate the billing tables")).toContain("/compact focus on: migrate the billing tables");
  });
});

describe("focusHint", () => {
  it("is one line, at most 60 chars, with no backticks or control characters", () => {
    const hint = focusHint("fix `runSync`\nthen\tdo   the other thing\u0007 " + "y".repeat(100));
    expect(hint).not.toMatch(/[`\n\t\u0007]/);
    expect(hint.length).toBeLessThanOrEqual(60);
    expect(hint.startsWith("fix runSync then do the other thing")).toBe(true);
    expect(focusHint("   \n ")).toBe("");
  });
});
