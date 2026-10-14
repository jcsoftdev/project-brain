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
  gatherTaskContext,
  taskSwitchMessage,
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
