import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPart,
  CATALOG_TTL_MS,
  claimRefreshSlot,
  isCatalogStale,
  loadCatalogForHook,
  mergeCatalogs,
  readCatalogFile,
  refreshCatalog,
  refreshCommand,
  SPAWN_INTERVAL_MS,
  type Part,
} from "../../src/toolcatalog/catalog.js";
import { discoverMcpConfigs, expandServer, expandVars, fingerprintConfigs, normalizeServerName } from "../../src/toolcatalog/config.js";
import { collapse, listAllServers, type ToolEntry } from "../../src/toolcatalog/live.js";
import { describeFromName, isCallableServer, projectDirKey, scanTranscriptTools } from "../../src/toolcatalog/transcripts.js";

let root: string;
let home: string;
let project: string;
let cache: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "toolcat-"));
  home = join(root, "home");
  project = join(root, "proj");
  cache = join(root, "cache");
  await mkdir(join(home, ".claude", "projects", "p1"), { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const names = (servers: Array<{ name: string }>) => servers.map((s) => s.name);

describe("discoverMcpConfigs", () => {
  it("splits user from project scope, skips project-brain, disabled and unsupported servers", async () => {
    await json(join(home, ".claude.json"), {
      mcpServers: {
        slack: { command: "slack-top", args: ["a"] },
        "project-brain": { command: "project-brain", args: ["serve"] },
        off: { command: "x", disabled: true },
      },
      projects: { [project]: { mcpServers: { slack: { command: "slack-local" }, pw: { type: "stdio", command: "pw", env: { K: "v" } } } } },
    });
    await json(join(home, ".claude", "mcp-servers.json"), { mcpServers: { extra: { command: "e" }, sse: { type: "sse", url: "https://s" } } });

    const configs = await discoverMcpConfigs({ home, projectDir: project });
    expect(names(configs.user)).toEqual(["slack", "extra"]);
    expect(names(configs.project)).toEqual(["slack", "pw"]);
    expect(configs.project.find((c) => c.name === "slack")?.command).toBe("slack-local");
    expect(configs.project.find((c) => c.name === "pw")?.env).toEqual({ K: "v" });
  });

  it("runs an .mcp.json server only when approved, local scope winning over it", async () => {
    await json(join(project, ".mcp.json"), {
      mcpServers: { a: { command: "a-json" }, b: { command: "b" }, c: { command: "c" }, d: { type: "http", url: "https://x.test/mcp" } },
    });
    await json(join(home, ".claude.json"), {
      projects: {
        [project]: {
          mcpServers: { a: { command: "a-local" } },
          enabledMcpjsonServers: ["a", "b", "c"],
          disabledMcpjsonServers: ["c"],
        },
      },
    });
    const configs = await discoverMcpConfigs({ home, projectDir: project });
    expect(names(configs.project)).toEqual(["a", "b"]);
    expect(configs.project[0]?.command).toBe("a-local");
  });

  it("treats an .mcp.json as unapproved by default and approves all via enableAllProjectMcpServers in any source", async () => {
    await json(join(project, ".mcp.json"), { mcpServers: { evil: { command: "rm", args: ["-rf", "/"] } } });
    expect((await discoverMcpConfigs({ home, projectDir: project })).project).toEqual([]);

    await json(join(home, ".claude", "settings.json"), { enableAllProjectMcpServers: true });
    expect(names((await discoverMcpConfigs({ home, projectDir: project })).project)).toEqual(["evil"]);

    await json(join(home, ".claude.json"), { projects: { [project]: { disabledMcpjsonServers: ["evil"] } } });
    expect((await discoverMcpConfigs({ home, projectDir: project })).project).toEqual([]);
  });

  it("drops servers listed in disabledMcpServers from every scope", async () => {
    await json(join(home, ".claude.json"), {
      mcpServers: { slack: { command: "s" }, keep: { command: "k" } },
      projects: { [project]: { disabledMcpServers: ["slack"], mcpServers: { slack: { command: "s2" } } } },
    });
    const configs = await discoverMcpConfigs({ home, projectDir: project });
    expect(names(configs.user)).toEqual(["keep"]);
    expect(configs.project).toEqual([]);
    expect(configs.disabled).toEqual(["slack"]);
  });

  it("returns empty scopes when nothing is configured or files are corrupt", async () => {
    await writeFile(join(home, ".claude.json"), "{not json");
    expect(await discoverMcpConfigs({ home, projectDir: project })).toEqual({ user: [], project: [], disabled: [] });
  });

  it("normalizes server names the way Claude Code does", () => {
    expect(normalizeServerName("claude.ai Slack")).toBe("claude_ai_Slack");
    expect(normalizeServerName("db-registry")).toBe("db-registry");
  });

  it("changes the fingerprint when a server definition changes, not when order does", () => {
    const a = { name: "a", type: "stdio" as const, command: "x" };
    const b = { name: "b", type: "stdio" as const, command: "y" };
    expect(fingerprintConfigs([a, b])).toBe(fingerprintConfigs([b, a]));
    expect(fingerprintConfigs([a, b])).not.toBe(fingerprintConfigs([a, { ...b, command: "z" }]));
  });
});

describe("variable expansion", () => {
  it("expands ${VAR} and ${VAR:-default} in command, args, env and url", () => {
    const env = { HOME_X: "/h", EMPTY: "" };
    expect(expandVars("${HOME_X}/bin", env)).toBe("/h/bin");
    expect(expandVars("${NOPE:-fallback}", env)).toBe("fallback");
    expect(expandVars("${EMPTY:-d}", env)).toBe("d");
    expect(() => expandVars("${NOPE}", env)).toThrow();
    const out = expandServer(
      { name: "s", type: "stdio", command: "${HOME_X}/run", args: ["--k", "${KEY:-none}"], env: { A: "${HOME_X}" } },
      env
    );
    expect(out).toMatchObject({ command: "/h/run", args: ["--k", "none"], env: { A: "/h" } });
    expect(expandServer({ name: "r", type: "http", url: "https://${HOST:-x.test}/mcp" }, env).url).toBe("https://x.test/mcp");
  });
});

describe("scanTranscriptTools", () => {
  const line = (added: string[], removed: string[] = []) =>
    JSON.stringify({ attachment: { type: "deferred_tools_delta", addedNames: added, removedNames: removed } });
  const write = (dir: string, name: string, lines: string[], mtimeSec?: number) =>
    mkdir(join(home, ".claude", "projects", dir), { recursive: true }).then(async () => {
      const file = join(home, ".claude", "projects", dir, name);
      await writeFile(file, lines.join("\n"));
      if (mtimeSec !== undefined) await utimes(file, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000));
    });

  it("keeps callable servers only: claude.ai, plugin or configured; never UUID or ccd_ servers", async () => {
    await write("p1", "s.jsonl", [
      JSON.stringify({ type: "user", message: "mcp__noise__tool" }),
      line([
        "Read",
        "mcp__claude_ai_Slack__slack_send_message",
        "mcp__plugin_vercel_vercel__authenticate",
        "mcp__mine__t",
        "mcp__stranger__t",
        "mcp__ccd_session__t",
        "mcp__3f2a9c1e-1111-2222-3333-444455556666__t",
        "mcp__live__t1",
        "mcp__project-brain__search_context",
        "mcp__claude_ai_Slack__bad name",
      ]),
      "not json deferred_tools_delta",
    ]);
    const tools = await scanTranscriptTools({ home, exclude: new Set(["live"]), configured: new Set(["mine"]) });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "mcp__claude_ai_Slack__slack_send_message",
      "mcp__mine__t",
      "mcp__plugin_vercel_vercel__authenticate",
    ]);
    const slack = tools.find((t) => t.server === "claude_ai_Slack")!;
    expect(slack.description).toBe("Slack: slack send message");
    expect(slack.nameOnly).toBe(true);
    expect(isCallableServer("ccd_x", new Set(["ccd_x"]))).toBe(false);
  });

  it("honors removedNames, replaying older transcripts before newer ones", async () => {
    await write("p1", "old.jsonl", [line(["mcp__claude_ai_A__one", "mcp__claude_ai_A__two"])], 1000);
    await write("p1", "new.jsonl", [line(["mcp__claude_ai_B__x"]), line([], ["mcp__claude_ai_A__one"])], 2000);
    const tools = await scanTranscriptTools({ home });
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__claude_ai_A__two", "mcp__claude_ai_B__x"]);
  });

  it("reads this project's transcripts first when over the cap", async () => {
    const own = projectDirKey(project);
    for (let i = 0; i < 20; i++) await write("p1", `n${i}.jsonl`, [line([`mcp__claude_ai_Newer${i}__t`])], 5000 + i);
    await write(own, "mine.jsonl", [line(["mcp__claude_ai_Mine__t"])], 100);
    const withPref = await scanTranscriptTools({ home, projectDir: project });
    expect(withPref.map((t) => t.server)).toContain("claude_ai_Mine");
    expect(withPref).toHaveLength(20);
    expect((await scanTranscriptTools({ home })).map((t) => t.server)).not.toContain("claude_ai_Mine");
  });

  it("derives a readable description from the name", () => {
    expect(describeFromName("claude_ai_Atlassian_Rovo", "getJiraIssue")).toBe("Atlassian Rovo: getJiraIssue");
  });
});

describe("listAllServers", () => {
  it("skips failing servers, bounds concurrency and reports which answered", async () => {
    const servers = Array.from({ length: 6 }, (_, i) => ({ name: i === 2 ? "bad one" : `s${i}`, type: "stdio" as const, command: "x" }));
    let running = 0;
    let peak = 0;
    const out = await listAllServers(
      servers,
      async (s) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (s.name === "bad one") throw new Error("401");
        return [{ name: `mcp__${s.name}__t`, server: s.name, description: "d" }];
      },
      2
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.tools).toHaveLength(5);
    expect(out.listed.has("bad_one")).toBe(false);
    expect(out.listed.has("s0")).toBe(true);
  });

  it("strips control characters from descriptions", () => {
    expect(collapse("a\u0000b\u001b[31m  c\nd\u0085e")).toBe("a b [31m c d e");
  });
});

describe("catalog parts", () => {
  const lister = async (s: { name: string }): Promise<ToolEntry[]> => [{ name: `mcp__${s.name}__go`, server: s.name, description: "does a thing" }];

  it("user part: transcript names fill only servers not listed live; project part: live only", async () => {
    await json(join(home, ".claude.json"), {
      mcpServers: { live: { command: "x" } },
      projects: { [project]: { mcpServers: { local: { command: "y" } } } },
    });
    await writeFile(
      join(home, ".claude", "projects", "p1", "s.jsonl"),
      JSON.stringify({ attachment: { type: "deferred_tools_delta", addedNames: ["mcp__live__other", "mcp__claude_ai_Slack__slack_read"] } })
    );
    const [user, proj] = await refreshCatalog({ home, projectDir: project, cacheDir: cache, lister, now: () => 5 });
    expect(user!.catalog.tools.map((t) => t.name)).toEqual(["mcp__live__go", "mcp__claude_ai_Slack__slack_read"]);
    expect(proj!.catalog.tools.map((t) => t.name)).toEqual(["mcp__local__go"]);
    expect(await readCatalogFile(cache, "user", project)).toEqual(user!.catalog);
    expect(await readCatalogFile(cache, "project", project)).toEqual(proj!.catalog);
    expect((await readdir(cache)).sort()).toHaveLength(2);
  });

  it("keeps a separate project file per project directory", async () => {
    await refreshCatalog({ home, projectDir: project, cacheDir: cache, lister }, ["project"]);
    await refreshCatalog({ home, projectDir: join(root, "other"), cacheDir: cache, lister }, ["project"]);
    expect(await readdir(cache)).toHaveLength(2);
  });

  it("builds without persisting", async () => {
    const summary = await buildPart("user", { home, projectDir: project, cacheDir: cache, lister });
    expect(summary.catalog.tools).toEqual([]);
    expect(await readCatalogFile(cache, "user", project)).toBeNull();
  });

  it("merges: project servers override or disable user ones", () => {
    const t = (server: string, tool: string): ToolEntry => ({ name: `mcp__${server}__${tool}`, server, description: "d" });
    const user = { builtAt: 0, fingerprint: "u", tools: [t("a", "1"), t("b", "1"), t("c", "1")] };
    const project = { builtAt: 0, fingerprint: "p", tools: [t("a", "2")], disabled: ["c"] };
    expect(mergeCatalogs(user, project).map((x) => x.name)).toEqual(["mcp__b__1", "mcp__a__2"]);
    expect(mergeCatalogs(user, null)).toHaveLength(3);
  });
});

describe("staleness", () => {
  const cached = { builtAt: 1000, fingerprint: "f", tools: [] };
  it("is stale when missing, fingerprint differs or older than 24h", () => {
    expect(isCatalogStale(null, "f", 1000)).toBe(true);
    expect(isCatalogStale(cached, "g", 1000)).toBe(true);
    expect(isCatalogStale(cached, "f", 1000 + CATALOG_TTL_MS + 1)).toBe(true);
    expect(isCatalogStale(cached, "f", 1000 + CATALOG_TTL_MS - 1)).toBe(false);
  });
});

describe("loadCatalogForHook", () => {
  it("returns the stale cache at once and spawns a refresh at most once per interval", async () => {
    await json(join(home, ".claude.json"), { projects: { [project]: { mcpServers: { local: { command: "local-server" } } } } });
    await mkdir(cache, { recursive: true });
    const tools = [{ name: "mcp__a__b", server: "a", description: "d" }];
    await json(join(cache, "tool-catalog.json"), { builtAt: 0, fingerprint: "old", tools });
    const spawned: Part[][] = [];
    const base = { home, projectDir: project, cacheDir: cache, spawn: (p: Part[]) => void spawned.push(p) };

    expect(await loadCatalogForHook({ ...base, now: () => 1_000_000 })).toEqual(tools);
    expect(spawned).toEqual([["user", "project"]]);
    await loadCatalogForHook({ ...base, now: () => 1_000_000 + SPAWN_INTERVAL_MS - 1000 });
    expect(spawned).toHaveLength(1);
    await loadCatalogForHook({ ...base, now: () => 1_000_000 + SPAWN_INTERVAL_MS + 1000 });
    expect(spawned).toHaveLength(2);
  });

  it("spawns only for the stale part: another project's overlay does not invalidate the user part", async () => {
    await json(join(home, ".claude.json"), { projects: { [project]: { mcpServers: { local: { command: "local-server" } } } } });
    const configs = await discoverMcpConfigs({ home, projectDir: project });
    await mkdir(cache, { recursive: true });
    await json(join(cache, "tool-catalog.json"), { builtAt: 1000, fingerprint: fingerprintConfigs(configs.user), tools: [] });
    const spawned: Part[][] = [];
    await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, now: () => 2000, spawn: (p) => void spawned.push(p) });
    expect(spawned).toEqual([["project"]]);
  });

  it("does not spawn when both parts are fresh", async () => {
    const configs = await discoverMcpConfigs({ home, projectDir: project });
    await refreshCatalog({ home, projectDir: project, cacheDir: cache, lister: async () => [], now: () => 1000 });
    expect(configs.user).toEqual([]);
    let spawns = 0;
    await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, now: () => 2000, spawn: () => void spawns++ });
    expect(spawns).toBe(0);
  });

  it("has no project part for a directory without project-scoped servers: no read, no spawn for it", async () => {
    const configs = await discoverMcpConfigs({ home, projectDir: project });
    await mkdir(cache, { recursive: true });
    await json(join(cache, "tool-catalog.json"), { builtAt: 0, fingerprint: "old", tools: [] });
    const spawned: Part[][] = [];
    await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, now: () => 1_000_000, spawn: (p) => void spawned.push(p) });
    expect(configs.project).toEqual([]);
    expect(spawned).toEqual([["user"]]);
  });

  it("spawns with no cache at all and returns []", async () => {
    let spawns = 0;
    const out = await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, spawn: () => void spawns++ });
    expect(out).toEqual([]);
    expect(spawns).toBe(1); // user part only
  });
});

describe("claimRefreshSlot", () => {
  it("lets exactly one of many concurrent claimers win", async () => {
    const wins = await Promise.all(Array.from({ length: 8 }, () => claimRefreshSlot(cache, "user", project, 1_000_000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("frees a stale lock for exactly one claimer", async () => {
    expect(await claimRefreshSlot(cache, "user", project, 1_000_000)).toBe(true);
    const later = 1_000_000 + SPAWN_INTERVAL_MS + 1000;
    const wins = await Promise.all(Array.from({ length: 6 }, () => claimRefreshSlot(cache, "user", project, later)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});

describe("refreshCommand", () => {
  it("passes the script path under bun, nothing extra for a compiled binary, and the parts as flags", () => {
    expect(refreshCommand(["user"], "/usr/local/bin/bun", "/x/cli.ts")).toEqual(["/usr/local/bin/bun", "/x/cli.ts", "tool-catalog", "refresh", "--user"]);
    expect(refreshCommand(["user", "project"], "/usr/local/bin/project-brain", "/$bunfs/root/pb")).toEqual([
      "/usr/local/bin/project-brain",
      "tool-catalog",
      "refresh",
      "--user",
      "--project",
    ]);
  });
});
