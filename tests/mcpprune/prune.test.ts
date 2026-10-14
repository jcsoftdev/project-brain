import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePlan } from "../../src/setup/plan.js";
import { allUnits, type SetupContext } from "../../src/setup/units.js";
import { applyPrune, planPrune, repoKey, revertPrune, type PruneEnv } from "../../src/mcpprune/prune.js";
import { classifyTool } from "../../src/mcpprune/usage.js";
import { projectDirKey } from "../../src/toolcatalog/transcripts.js";

const DAY = 86_400_000;
const SERVERS = { alpha: { command: "a" }, beta: { command: "b" }, "project-brain": { command: "p" } };

let root: string;
let env: PruneEnv;
const claudeJson = () => join(root, ".claude.json");
const readJson = async () => JSON.parse(await readFile(claudeJson(), "utf-8"));

async function project(name: string): Promise<string> {
  const dir = join(root, "work", name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function transcripts(dir: string, count: number, tools: string[] = [], ageDays = 1): Promise<void> {
  const tdir = join(root, ".claude", "projects", projectDirKey(dir));
  await mkdir(tdir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.now() - (ageDays + i) * DAY);
    const calls = i === 0 ? tools.map((name) => ({ type: "tool_use", name })) : [];
    const line = JSON.stringify({ timestamp: at.toISOString(), message: { content: calls } });
    const file = join(tdir, `${dir.replaceAll("/", "")}-${i}-${tools.join("")}.jsonl`);
    await writeFile(file, `${line}\n`);
    await utimes(file, at, at);
  }
}

async function writeClaude(projects: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const entries = Object.fromEntries(projects.map((p) => [p, { allowedTools: [], keep: 1 }]));
  await writeFile(claudeJson(), JSON.stringify({ numStartups: 3, mcpServers: SERVERS, projects: entries, ...extra }, null, 2));
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pb-mcp-prune-")));
  env = { home: root, dataDir: join(root, "data") };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("classifyTool", () => {
  it("maps configured, claude.ai and plugin tool ids", () => {
    expect(classifyTool("mcp__alpha__do_it", ["alpha"])).toEqual({ server: "alpha", kind: "configured" });
    expect(classifyTool("mcp__my_srv__t", ["my.srv"])).toEqual({ server: "my_srv", kind: "configured" });
    expect(classifyTool("mcp__claude_ai_Slack__send", ["alpha"])).toEqual({ server: "claude_ai_Slack", kind: "claude_ai" });
    expect(classifyTool("mcp__plugin_engram_engram__mem_save", ["alpha"])).toEqual({ server: "plugin_engram_engram", kind: "plugin" });
    expect(classifyTool("not-a-tool", [])).toBeNull();
  });
});

describe("planPrune", () => {
  it("proposes unused servers only, never project-brain, allowlisted or thin-history ones", async () => {
    const [a, thin, gone] = [await project("a"), await project("thin"), join(root, "work", "gone")];
    await writeClaude([a, thin, gone]);
    await transcripts(a, 10, ["mcp__alpha__x"]);
    await transcripts(thin, 2);
    await transcripts(gone, 12);

    const plans = await planPrune({ ...env, allow: [] });
    const byProject = Object.fromEntries(plans.map((p) => [p.project, p]));
    expect(byProject[a]!.candidates.map((c) => c.name)).toEqual(["beta"]);
    expect(byProject[thin]!.skipped).toBe("not enough history yet");
    expect(byProject[gone]!.skipped).toBe("directory no longer exists");

    const allowed = await planPrune({ ...env, allow: ["beta"] }, [a]);
    expect(allowed[0]!.candidates).toEqual([]);
  });

  it("counts 14 days of history as enough, and ignores usage outside the window", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 2, [], 20); // spans 1 day only: thin
    expect((await planPrune(env, [a]))[0]!.skipped).toBe("not enough history yet");
    await transcripts(a, 3, ["mcp__alpha__x"], 14);
    await transcripts(a, 1, ["mcp__beta__x"], 45);
    const [plan] = await planPrune(env, [a]);
    expect(plan!.skipped).toBeUndefined();
    expect(plan!.candidates.map((c) => c.name)).toEqual(["beta"]);
  });

  it("needs 10 sessions, or 14 days of history with at least 3 sessions inside the window", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 2, [], 20);
    await transcripts(a, 1, ["mcp__old__t"], 45); // spans 25 days but only 2 sessions are inside the window
    expect((await planPrune(env, [a]))[0]!.skipped).toBe("not enough history yet");
    await transcripts(a, 1, ["mcp__x__y"], 10);
    expect((await planPrune(env, [a]))[0]!.skipped).toBeUndefined();
  });

  it("pools usage across worktrees of the same repo", async () => {
    const main = await project("repo");
    Bun.spawnSync(["git", "init", "-q", main]);
    Bun.spawnSync(["git", "-C", main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
    const wt = join(main, ".claude", "worktrees", "agent-1");
    Bun.spawnSync(["git", "-C", main, "worktree", "add", "-q", wt]);
    expect(repoKey(wt)).toBe(main);
    expect(repoKey(join(main, ".claude", "worktrees", "removed"))).toBe(main);

    await writeClaude([main, wt]);
    await transcripts(main, 12, ["mcp__alpha__x"]);
    await transcripts(wt, 1);
    const plans = Object.fromEntries((await planPrune(env)).map((p) => [p.project, p]));
    expect(plans[wt]!.skipped).toBeUndefined();
    expect(plans[wt]!.candidates.map((c) => c.name)).toEqual(["beta"]);
    expect(plans[main]!.candidates.map((c) => c.name)).toEqual(["beta"]);
  });
});

describe("applyPrune / revertPrune", () => {
  it("disables only in the project that did not use the server, then reverts exactly", async () => {
    const [a, b] = [await project("a"), await project("b")];
    await writeClaude([a, b]);
    await transcripts(a, 10);
    await transcripts(b, 10, ["mcp__alpha__x", "mcp__beta__y"]);
    const before = await readJson();

    const result = await applyPrune(env, await planPrune(env));
    expect(result.error).toBeUndefined();
    const after = await readJson();
    expect(after.projects[a].disabledMcpServers).toEqual(["alpha", "beta"]);
    expect(after.projects[b].disabledMcpServers).toBeUndefined();
    expect({ ...after, projects: undefined }).toEqual({ ...before, projects: undefined });
    expect(after.projects[a].keep).toBe(1);
    expect((await readFile(claudeJson(), "utf-8")).includes('\n  "numStartups"')).toBe(true);

    expect((await applyPrune(env, await planPrune(env))).added).toEqual([]);

    const reverted = await revertPrune(env);
    expect(reverted.removed.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect((await readJson()).projects[a].disabledMcpServers).toEqual([]);
    expect((await planPrune(env, [a]))[0]!.candidates).toEqual([]); // reverted means kept for good
  });

  async function vanish(a: string): Promise<void> {
    const json = await readJson();
    json.projects[a].disabledMcpServers = ["beta"];
    await writeFile(claudeJson(), JSON.stringify(json, null, 2));
  }

  it("keeps off the list a server that vanished and was used since", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    await applyPrune({ ...env, now: Date.now() - 2 * DAY }, await planPrune(env));
    await vanish(a);
    await transcripts(a, 1, ["mcp__alpha__x"], 0);

    expect((await planPrune(env, [a]))[0]!.candidates.map((c) => c.name)).not.toContain("alpha");
    const second = await applyPrune(env, await planPrune(env, [a]));
    expect(second.added).toEqual([]);
    expect(JSON.parse(await readFile(join(env.dataDir, "mcp-prune.json"), "utf-8")).keep).toContain("alpha");
  });

  it("keeps a vanished server off the list for good and cleans it from the manifest even when nothing else changes", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    await applyPrune(env, await planPrune(env));
    await vanish(a);

    const second = await applyPrune(env, await planPrune(env, [a]));
    expect(second.added).toEqual([]);
    expect((await readJson()).projects[a].disabledMcpServers).toEqual(["beta"]);
    const state = JSON.parse(await readFile(join(env.dataDir, "mcp-prune.json"), "utf-8"));
    expect(state.keep).toEqual(["alpha"]);
    expect(state.disabled.map((e: { name: string }) => e.name)).toEqual(["beta"]);
    expect((await planPrune(env, [a]))[0]!.candidates.map((c) => c.name)).not.toContain("alpha");
  });

  const manifest = async () => JSON.parse(await readFile(join(env.dataDir, "mcp-prune.json"), "utf-8"));

  it("records entries as pending before the file is written, then confirms them", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    let seen: Array<{ name: string; pending?: boolean }> = [];
    const result = await applyPrune({ ...env, beforeRename: async () => void (seen = (await manifest()).disabled) }, await planPrune(env));
    expect(seen.map((e) => [e.name, e.pending])).toEqual([["alpha", true], ["beta", true]]);
    expect((await manifest()).disabled.map((e: { pending?: boolean }) => e.pending)).toEqual([undefined, undefined]);
    expect(result.added).toHaveLength(2);
  });

  it("drops pending entries when the write is abandoned, and --revert undoes a crash that left them", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    const plans = await planPrune(env);
    const racing: PruneEnv = { ...env, beforeRename: () => writeFileSync(claudeJson(), JSON.stringify({ projects: { [a]: {} }, pad: "x".repeat(Math.random() * 99) })) };
    expect((await applyPrune(racing, plans)).error).toContain("kept changing");
    expect((await manifest()).disabled).toEqual([]);

    // a crash after the manifest write but before/after the rename leaves pending entries behind
    const json = await readJson();
    json.projects[a].disabledMcpServers = ["alpha"];
    await writeFile(claudeJson(), JSON.stringify(json, null, 2));
    const entry = (name: string) => ({ project: a, name, keys: ["disabledMcpServers"], at: new Date().toISOString(), pending: true });
    await mkdir(env.dataDir, { recursive: true });
    await writeFile(join(env.dataDir, "mcp-prune.json"), JSON.stringify({ keep: [], disabled: [entry("alpha"), entry("beta")] }));
    const reverted = await revertPrune(env);
    expect(reverted.removed.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect((await readJson()).projects[a].disabledMcpServers).toEqual([]);
  });

  it("settles leftover pending entries on the next apply: landed ones are kept, the rest dropped", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10, ["mcp__alpha__x", "mcp__beta__y"]);
    const json = await readJson();
    json.projects[a].disabledMcpServers = ["alpha"];
    await writeFile(claudeJson(), JSON.stringify(json, null, 2));
    const entry = (name: string) => ({ project: a, name, keys: ["disabledMcpServers"], at: new Date().toISOString(), pending: true });
    await mkdir(env.dataDir, { recursive: true });
    await writeFile(join(env.dataDir, "mcp-prune.json"), JSON.stringify({ keep: [], disabled: [entry("alpha"), entry("beta")] }));
    await applyPrune(env, await planPrune(env));
    expect((await manifest()).disabled.map((e: { name: string; pending?: boolean }) => [e.name, e.pending])).toEqual([["alpha", undefined]]);
  });

  it("keeps only the newest 5 backups", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    const backups = join(env.dataDir, "mcp-prune");
    for (let i = 0; i < 7; i++) {
      await writeClaude([a]);
      await rm(join(env.dataDir, "mcp-prune.json"), { force: true });
      await applyPrune({ ...env, now: Date.now() + i * 1000 }, await planPrune(env));
    }
    const left = (await readdir(backups)).filter((n) => n.endsWith(".bak"));
    expect(left).toHaveLength(5);
  });

  it("aborts without writing when the file keeps changing underneath", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    const plans = await planPrune(env);
    let n = 0;
    const racing: PruneEnv = {
      ...env,
      get allow() {
        writeFileSync(claudeJson(), JSON.stringify({ projects: { [a]: {} }, pad: "x".repeat(++n * 7) }));
        return [];
      },
    };
    const result = await applyPrune(racing, plans);
    expect(result.error).toContain("kept changing");
    expect((await readJson()).projects[a].disabledMcpServers).toBeUndefined();
  });
});

describe("config:mcp-prune unit", () => {
  const ctxFor = (): SetupContext =>
    ({ dataDir: env.dataDir, installed: [], claudeSettingsPath: join(root, ".claude", "settings.json") }) as unknown as SetupContext;
  const unit = () => allUnits(ctxFor()).find((u) => u.id === "config:mcp-prune")!;

  it("processes every project whatever the cwd, and is idempotent", async () => {
    const [a, b] = [await project("a"), await project("b")];
    await writeClaude([a, b]);
    await transcripts(a, 10);
    await transcripts(b, 10, ["mcp__beta__y"]);
    expect(process.cwd()).not.toBe(a);

    expect(await unit().inspect(ctxFor())).toBe("absent");
    await unit().apply(ctxFor());
    const json = await readJson();
    expect(json.projects[a].disabledMcpServers).toEqual(["alpha", "beta"]);
    expect(json.projects[b].disabledMcpServers).toEqual(["alpha"]);

    expect(await unit().inspect(ctxFor())).toBe("current");
    await unit().apply(ctxFor());
    expect(await readJson()).toEqual(json);
    expect(unit().autoOnUpgrade).toBe(true);
  });

  it("reports unavailable when opted out, so the saved selection never records it", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    process.env.PROJECT_BRAIN_MCP_PRUNE = "0";
    try {
      expect(await unit().inspect(ctxFor())).toBe("unavailable");
    } finally {
      delete process.env.PROJECT_BRAIN_MCP_PRUNE;
    }
  });

  it("is present once the manifest has entries, so unticking it reverts", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    await unit().apply(ctxFor());
    expect(await unit().inspect(ctxFor())).toBe("current");
    expect(computePlan([{ id: "config:mcp-prune", state: "current", chosen: false }] as never)[0]!.action).toBe("remove");

    const b = await project("b");
    await writeClaude([a, b]);
    const json = await readJson();
    json.projects[a].disabledMcpServers = ["alpha", "beta"];
    await writeFile(claudeJson(), JSON.stringify(json, null, 2));
    await transcripts(b, 10);
    expect(await unit().inspect(ctxFor())).toBe("stale");

    await unit().remove!(ctxFor());
    expect((await readJson()).projects[a].disabledMcpServers).toEqual([]);
  });

  it("does nothing when opted out and is unavailable without a .claude settings path", async () => {
    const a = await project("a");
    await writeClaude([a]);
    await transcripts(a, 10);
    process.env.PROJECT_BRAIN_MCP_PRUNE = "0";
    try {
      await unit().apply(ctxFor());
    } finally {
      delete process.env.PROJECT_BRAIN_MCP_PRUNE;
    }
    expect((await readJson()).projects[a].disabledMcpServers).toBeUndefined();
    expect(await unit().inspect({ ...ctxFor(), claudeSettingsPath: join(root, "settings.json") })).toBe("unavailable");
  });
});
