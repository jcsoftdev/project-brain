import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, hookFloor } from "../../src/commands/stats.js";
import { injection, instructionsDelta, toolsDelta, toolUse, transcript, userPrompt } from "../ledger/fixtures.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const PROMPT = "PROMPT-TEXT-MUST-NOT-LEAK";
const GATE_HEAD = "GATE-HEAD-MUST-NOT-LEAK";

let root: string;
let projectsRoot: string;
let dataDir: string;
let app: string;

const folder = (cwd: string) => join(projectsRoot, cwd.replace(/[^a-zA-Z0-9]/g, "-"));

async function writeTranscript(path: string, lines: string[], mtime: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, transcript(lines));
  await utimes(path, mtime / 1000, mtime / 1000);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pb-stats-"));
  projectsRoot = join(root, "projects");
  dataDir = join(root, "data");
  app = join(root, "work", "app");
  await mkdir(join(app, ".project-brain"), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const main = { sessionId: "sess-main", cwd: app, at: "2026-11-14T09:00:00.000Z" };
  const agent = { ...main, cwd: join(app, ".claude", "worktrees", "agent-1"), agentId: "agent-1", at: "2026-11-14T09:10:00.000Z" };
  await writeTranscript(
    join(folder(app), "sess-main.jsonl"),
    [
      toolsDelta(main, ["mcp__alpha__one", "mcp__alpha__two"]),
      instructionsDelta(main, { alpha: "a".repeat(400) }),
      userPrompt(main, PROMPT),
      injection(main, [
        { source: "src/a.ts", lines: [1, 9], score: 0.82 },
        { source: "src/b.ts", score: 0.67 },
      ]),
      toolUse(main, "Read", { file_path: join(app, "src/a.ts") }),
    ],
    NOW - 86_400_000
  );
  await writeTranscript(
    join(folder(app), "sess-main", "subagents", "agent-agent-1.jsonl"),
    [toolsDelta(agent, ["mcp__alpha__one"]), injection(agent, [{ source: "src/c.ts", score: 0.7 }])],
    NOW - 86_000_000
  );
  // Older than the default window.
  const old = { sessionId: "sess-old", cwd: app, at: "2026-10-01T09:00:00.000Z" };
  await writeTranscript(join(folder(app), "sess-old.jsonl"), [injection(old, [{ source: "src/old.ts", score: 0.9 }])], Date.parse(old.at));
  // Another project.
  const other = { sessionId: "sess-other", cwd: join(root, "work", "other"), at: "2026-11-14T10:00:00.000Z" };
  await writeTranscript(join(folder(other.cwd), "sess-other.jsonl"), [toolsDelta(other, ["mcp__beta__x", "mcp__plugin_gamma_g__t"])], NOW - 80_000_000);

  await writeFile(
    join(dataDir, "context-gate-log.json"),
    JSON.stringify({
      dropped: [
        { at: NOW, session: "sess-main", type: "hook_additional_context", event: "SessionStart", chars: 800, score: 0.1, head: GATE_HEAD },
        { at: NOW, session: "sess-other", type: "hook_additional_context", event: "PostToolUse", chars: 40, score: 0.1, head: GATE_HEAD },
      ],
    })
  );
  await writeFile(
    join(dataDir, "mcp-prune.json"),
    JSON.stringify({
      keep: [],
      disabled: [
        { project: app, name: "beta", keys: ["disabledMcpServers"], at: "2026-11-01T00:00:00.000Z" },
        { project: app, name: "plugin:gamma:g", keys: ["disabledMcpServers"], at: "2026-11-01T00:00:00.000Z" },
        { project: app, name: "gamma", keys: ["disabledMcpServers"], at: "2026-11-01T00:00:00.000Z", pending: true },
        { project: app, name: "late", keys: ["disabledMcpServers"], at: "2026-11-15T00:00:00.000Z" },
      ],
    })
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  process.exitCode = 0;
});

async function run(args: string[]): Promise<string[]> {
  const out: string[] = [];
  await execute(args, { projectsRoot, dataDir, cwd: app, now: NOW, log: (l) => out.push(l) });
  return out;
}

describe("project-brain stats", () => {
  it("reports one session of the current project in the window, its agents rolled in", async () => {
    const json = JSON.parse((await run(["--json"])).join("\n"));
    expect(json.scope).toBe(app);
    expect(json.estimator).toBe("chars/4");
    expect(json.sessions).toHaveLength(1);
    const s = json.sessions[0];
    expect(s.sessionId).toBe("sess-main");
    expect(s.transcripts).toBe(2);
    expect(s.injected.prompts).toBe(2);
    expect(s.injected.hits).toBe(3);
    expect(s.injected.tokens).toBe(Math.ceil(s.injected.chars / 4));
    expect(s.usage).toEqual({ hits: 3, used: 1 });
    expect(s.gateDropped).toEqual({ count: 1, chars: 800, tokens: 200, byEvent: { SessionStart: 1 } });
    expect(s.mcp.servers).toBe(1);
    expect(s.mcp.byServer.alpha.tools).toBe(2);
    expect(s.mcp.agentTokens).toBe(Math.ceil(("mcp__alpha__one".length + 1) / 4));
    // Pruned before the session began and confirmed; beta's cost is unseen in this project's sessions.
    expect(s.pruned).toEqual([
      { name: "beta", tokens: null },
      { name: "plugin:gamma:g", tokens: null },
    ]);
    expect(json.projects).toHaveLength(1);
    expect(json.projects[0].signal.used).toBe(1);
  });

  it("never prints prompt text or gate log heads", async () => {
    for (const args of [["--json", "--all"], ["--all"]]) {
      const text = (await run(args)).join("\n");
      expect(text).not.toContain(PROMPT);
      expect(text).not.toContain(GATE_HEAD);
      expect(text).not.toContain("first snippet line");
    }
  });

  it("--all adds other projects and prices a pruned server from where it was seen", async () => {
    const json = JSON.parse((await run(["--json", "--all"])).join("\n"));
    expect(json.scope).toBe("all");
    expect(json.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(["sess-main", "sess-other"]);
    const main = json.sessions.find((s: { sessionId: string }) => s.sessionId === "sess-main");
    // Priced under Claude Code's spelling of the name, whichever form the prune state holds.
    expect(main.pruned).toEqual([
      { name: "beta", tokens: Math.ceil(("mcp__beta__x".length + 1) / 4) },
      { name: "plugin:gamma:g", tokens: Math.ceil(("mcp__plugin_gamma_g__t".length + 1) / 4) },
    ]);
  });

  it("--days widens the window", async () => {
    const json = JSON.parse((await run(["--json", "--days", "60"])).join("\n"));
    expect(json.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(["sess-main", "sess-old"]);
  });

  it("accepts --days=N", async () => {
    const json = JSON.parse((await run(["--json", "--days=60"])).join("\n"));
    expect(json.days).toBe(60);
    expect(json.sessions).toHaveLength(2);
  });

  it("exits 2 with a message on a bad value or an unknown flag", async () => {
    const err = console.error;
    const messages: string[] = [];
    console.error = (m: string) => messages.push(m);
    try {
      for (const args of [["--days", "0"], ["--days=x"], ["--days"], ["--dayz", "3"], ["--jsn"], ["extra"]]) {
        process.exitCode = 0;
        expect(await run(args)).toEqual([]);
        expect(process.exitCode).toBe(2);
      }
      expect(messages[0]).toContain("--days needs a positive whole number");
      expect(messages[3]).toContain('unknown argument "--dayz"');
    } finally {
      console.error = err;
    }
  });

  it("outside an initialized project or git repository, scopes to exactly this directory and says so", async () => {
    const out: string[] = [];
    await execute([], { projectsRoot, dataDir, cwd: join(root, "work"), now: NOW, log: (l) => out.push(l) });
    expect(out[0]).toContain("(this directory only)");
    expect(out.join("\n")).toContain("No sessions in this window.");
    const json: string[] = [];
    await execute(["--json"], { projectsRoot, dataDir, cwd: join(root, "work"), now: NOW, log: (l) => json.push(l) });
    expect(JSON.parse(json.join("\n")).scopeKind).toBe("directory");
  });

  it("counts only the injections and gate drops inside the window", async () => {
    const at = (iso: string) => ({ sessionId: "sess-span", cwd: app, at: iso });
    await writeTranscript(
      join(folder(app), "sess-span.jsonl"),
      [injection(at("2026-11-01T09:00:00.000Z"), [{ source: "src/before.ts", score: 0.9 }]), injection(at("2026-11-14T09:00:00.000Z"), [{ source: "src/inside.ts", score: 0.9 }])],
      NOW - 3_600_000
    );
    const json = JSON.parse((await run(["--json"])).join("\n"));
    const span = json.sessions.find((s: { sessionId: string }) => s.sessionId === "sess-span");
    expect(span.injected.prompts).toBe(1);
    expect(span.hits.map((h: { source: string }) => h.source)).toEqual(["src/inside.ts"]);
  });

  it("reads a project folder reached through a symlinked alias once", async () => {
    await symlink(folder(app), join(projectsRoot, `${folder(app).split("/").pop()}-alias`));
    const json = JSON.parse((await run(["--json", "--all"])).join("\n"));
    expect(json.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(["sess-main", "sess-other"]);
    expect(json.scanned.files).toBe(3);
  });

  it("applies the byte budget per session, never splitting a session from its subagents", async () => {
    const { buildLedger } = await import("../../src/ledger/scan.js");
    const sizes = await Promise.all([join(folder(app), "sess-main.jsonl"), join(folder(app), "sess-main", "subagents", "agent-agent-1.jsonl")].map((p) => stat(p).then((s) => s.size)));
    const ledger = await buildLedger({ projectsRoot, dataDir, days: 7, projectRoot: app, now: NOW, maxBytes: sizes[0]! + 1 });
    expect(ledger.scanned.truncated).toBe(true);
    expect(ledger.sessions).toEqual([]);
    const whole = await buildLedger({ projectsRoot, dataDir, days: 7, projectRoot: app, now: NOW, maxBytes: sizes[0]! + sizes[1]! });
    expect(whole.sessions[0]!.transcripts).toBe(2);
  });

  it("runs without the CLI preamble, so it never refreshes skills or repairs configs", async () => {
    const home = join(root, "home");
    const claudeJson = join(home, ".claude.json");
    const broken = JSON.stringify({ mcpServers: { "project-brain": { command: "bun", args: ["/opt/homebrew/bin/project-brain"], transport: "stdio" } } });
    await mkdir(home, { recursive: true });
    await writeFile(claudeJson, broken);
    const proc = Bun.spawn(["bun", "src/cli.ts", "stats", "--all", "--days", "1"], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), BRAIN_FORCE_SKILL_REFRESH: "1", BRAIN_NO_UPDATE_CHECK: "", BRAIN_NO_SKILL_REFRESH: "", BRAIN_NO_CONFIG_REPAIR: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("project-brain stats: last 1 days, all projects");
    expect(stderr).not.toContain("fixed the MCP launch command");
    expect(await readFile(claudeJson, "utf-8")).toBe(broken);
  }, 30_000);

  it("prints a readable summary with estimated tokens and the floor in force", async () => {
    const text = (await run([])).join("\n");
    expect(text).toContain("last 7 days");
    expect(text).toContain("estimates (chars/4)");
    expect(text).toContain("injected 2 prompts / 3 hits");
    expect(text).toContain("used 1/3");
    expect(text).toContain("pruned: beta");
    expect(text).toContain("usage signal (report only): 3 distinct injected hits, 1 used (read 1)");
    expect(text).toContain("Hook floor for every project: 0.65 (global default");
  });

  it("says so when the window holds no session", async () => {
    const out: string[] = [];
    await execute([], { projectsRoot, dataDir, cwd: join(root, "work", "empty"), now: NOW, log: (l) => out.push(l) });
    expect(out.join("\n")).toContain("No sessions in this window.");
  });
});

describe("hookFloor", () => {
  it("reports the env override when valid and the global default otherwise", async () => {
    expect(await hookFloor({ PROJECT_BRAIN_SEARCH_MIN_SCORE: "0.7" })).toEqual({ floor: 0.7, source: "env", basis: "PROJECT_BRAIN_SEARCH_MIN_SCORE" });
    expect((await hookFloor({ PROJECT_BRAIN_SEARCH_MIN_SCORE: "7" })).source).toBe("default");
    expect((await hookFloor({})).floor).toBe(0.65);
  });
});
