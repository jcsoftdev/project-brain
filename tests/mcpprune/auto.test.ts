import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { maintainMcpPrune } from "../../src/commands/maintain.js";
import { acquirePidFileLock } from "../../src/commands/sync-lock.js";
import { applyPrune, planPrune, pruneLockPath } from "../../src/mcpprune/prune.js";
import { registerProject } from "../../src/store/project-registry.js";
import { projectDirKey } from "../../src/toolcatalog/transcripts.js";

const SERVERS = { alpha: { command: "a" }, beta: { command: "b" }, "project-brain": { command: "p" } };

let root: string;
let dataDir: string;
let saved: { key?: string; optIn?: string };
let requests: number;

const readJson = async () => JSON.parse(await readFile(join(root, ".claude.json"), "utf-8"));

/** Jev stand-in: alpha is needed, beta is not. */
const fakeFetch = async (_url: string, init: RequestInit): Promise<Response> => {
  requests++;
  const body = JSON.parse(String(init.body)) as { state: { servers: Record<string, { name: string }> } };
  const answers = Object.fromEntries(Object.entries(body.state.servers).map(([k, s]) => [k, { type: "noul", noul: s.name === "beta" ? 0.05 : 0.9 }]));
  return new Response(JSON.stringify({ answers }), { status: 200 });
};
const failingFetch = async (): Promise<Response> => {
  requests++;
  return new Response("down", { status: 503 });
};

/** A project Claude Code has seen once, whose session announced both servers' tools. */
async function thinProject(name: string): Promise<string> {
  const dir = join(root, "work", name);
  await mkdir(dir, { recursive: true });
  const tdir = join(root, ".claude", "projects", projectDirKey(dir));
  await mkdir(tdir, { recursive: true });
  const at = new Date(Date.now() - 86_400_000);
  const line = { type: "attachment", timestamp: at.toISOString(), attachment: { type: "deferred_tools_delta", addedNames: ["mcp__alpha__deploy", "mcp__beta__model_3d"] } };
  const file = join(tdir, "s1.jsonl");
  await writeFile(file, `${JSON.stringify(line)}\n`);
  await utimes(file, at, at);
  return dir;
}

async function writeClaude(projects: string[]): Promise<void> {
  const entries = Object.fromEntries(projects.map((p) => [p, { allowedTools: [] }]));
  await writeFile(join(root, ".claude.json"), JSON.stringify({ mcpServers: SERVERS, projects: entries }, null, 2));
}

const init = (dir: string, jevFetch = fakeFetch) =>
  runInit({ root: dir, dataDir, claudeHome: root, jevFetch, skipGitHook: true, skipIndex: true, skipRules: true, skipClaudeHook: true });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pb-mcp-auto-")));
  dataDir = join(root, "data");
  requests = 0;
  saved = { key: process.env.TYPESAFE_API_KEY, optIn: process.env.PROJECT_BRAIN_MCP_PRUNE_JEV };
  process.env.TYPESAFE_API_KEY = "test-token";
  delete process.env.PROJECT_BRAIN_MCP_PRUNE_JEV;
});
afterEach(async () => {
  if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = saved.key;
  if (saved.optIn === undefined) delete process.env.PROJECT_BRAIN_MCP_PRUNE_JEV;
  else process.env.PROJECT_BRAIN_MCP_PRUNE_JEV = saved.optIn;
  await rm(root, { recursive: true, force: true });
});

describe("init with the opt-in Jev assist", () => {
  it("prunes only its own project, with exactly one request, and says so", async () => {
    process.env.PROJECT_BRAIN_MCP_PRUNE_JEV = "1";
    const [a, b] = [await thinProject("a"), await thinProject("b")];
    await writeClaude([a, b]);
    await registerProject(dataDir, "b", b);

    const result = await init(a);
    expect(requests).toBe(1);
    const json = await readJson();
    expect(json.projects[a].disabledMcpServers).toEqual(["beta"]);
    expect(json.projects[b].disabledMcpServers).toBeUndefined();
    expect(result.mcpPrune?.line).toContain("disabled beta for the next session");
  });

  it("does nothing, and prints nothing new, with the opt-in off", async () => {
    const a = await thinProject("a");
    await writeClaude([a]);
    const result = await init(a);
    expect(requests).toBe(0);
    expect(result.mcpPrune).toBeUndefined();
    expect((await readJson()).projects[a].disabledMcpServers).toBeUndefined();
  });

  it("still succeeds when Jev fails, and keeps every server", async () => {
    process.env.PROJECT_BRAIN_MCP_PRUNE_JEV = "1";
    const a = await thinProject("a");
    await writeClaude([a]);
    const result = await init(a, failingFetch);
    expect(requests).toBe(1);
    expect(result.projectId.length).toBeGreaterThan(0);
    expect(result.mcpPrune).toBeUndefined();
    expect((await readJson()).projects[a].disabledMcpServers).toBeUndefined();
  });
});

describe("maintain with the opt-in Jev assist", () => {
  it("prunes every registered project, and never an unregistered one", async () => {
    process.env.PROJECT_BRAIN_MCP_PRUNE_JEV = "1";
    const [a, b, c] = [await thinProject("a"), await thinProject("b"), await thinProject("c")];
    await writeClaude([a, b, c]);
    await registerProject(dataDir, "a", a);
    await registerProject(dataDir, "b", b);

    const r = await maintainMcpPrune({ dataDir, home: root, fetchFn: fakeFetch });
    expect(r?.ran).toBe(true);
    expect(requests).toBe(2);
    const json = await readJson();
    expect(json.projects[a].disabledMcpServers).toEqual(["beta"]);
    expect(json.projects[b].disabledMcpServers).toEqual(["beta"]);
    expect(json.projects[c].disabledMcpServers).toBeUndefined();
  });

  it("makes no request with the opt-in off", async () => {
    const a = await thinProject("a");
    await writeClaude([a]);
    await registerProject(dataDir, "a", a);
    expect(await maintainMcpPrune({ dataDir, home: root, fetchFn: fakeFetch })).toEqual({ ran: false, reason: "off" });
    expect(requests).toBe(0);
  });

  it("skips silently while another prune holds the lock, and so does a concurrent apply", async () => {
    process.env.PROJECT_BRAIN_MCP_PRUNE_JEV = "1";
    const a = await thinProject("a");
    await writeClaude([a]);
    await registerProject(dataDir, "a", a);
    const env = { home: root, dataDir };
    const lock = await acquirePidFileLock(pruneLockPath(env));
    expect(lock).not.toBeNull();
    try {
      expect(await maintainMcpPrune({ dataDir, home: root, fetchFn: fakeFetch })).toEqual({ ran: false, reason: "locked" });
      expect(requests).toBe(0);
      const applied = await applyPrune(env, await planPrune({ ...env, minSessions: 1 }, [a]));
      expect(applied.locked).toBe(true);
      expect((await readJson()).projects[a].disabledMcpServers).toBeUndefined();
    } finally {
      await lock!.release();
    }
    expect((await maintainMcpPrune({ dataDir, home: root, fetchFn: fakeFetch }))?.ran).toBe(true);
  });
});
