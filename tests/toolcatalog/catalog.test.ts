import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalog,
  CATALOG_TTL_MS,
  isCatalogStale,
  loadCatalogForHook,
  refreshCatalog,
  refreshCommand,
  SPAWN_INTERVAL_MS,
  readCatalogFile,
} from "../../src/toolcatalog/catalog.js";
import { discoverMcpConfigs, fingerprintConfigs, normalizeServerName } from "../../src/toolcatalog/config.js";
import { listAllServers, type ToolEntry } from "../../src/toolcatalog/live.js";
import { describeFromName, scanTranscriptTools } from "../../src/toolcatalog/transcripts.js";

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

describe("discoverMcpConfigs", () => {
  it("merges every source, first definition wins, skips project-brain and disabled servers", async () => {
    await json(join(home, ".claude.json"), {
      mcpServers: {
        slack: { command: "slack-top", args: ["a"] },
        "project-brain": { command: "project-brain", args: ["serve"] },
        off: { command: "x", disabled: true },
      },
      projects: { [project]: { mcpServers: { slack: { command: "slack-project" }, pw: { type: "stdio", command: "pw", env: { K: "v" } } } } },
    });
    await json(join(project, ".mcp.json"), { mcpServers: { remote: { type: "http", url: "https://x.test/mcp" } } });
    await json(join(home, ".claude", "mcp-servers.json"), { mcpServers: { extra: { command: "e" }, sse: { type: "sse", url: "https://s" } } });

    const configs = await discoverMcpConfigs({ home, projectDir: project });
    expect(configs.map((c) => c.name)).toEqual(["remote", "slack", "pw", "extra"]);
    expect(configs.find((c) => c.name === "slack")?.command).toBe("slack-project");
    expect(configs.find((c) => c.name === "remote")).toMatchObject({ type: "http", url: "https://x.test/mcp" });
    expect(configs.find((c) => c.name === "pw")?.env).toEqual({ K: "v" });
  });

  it("returns [] when nothing is configured or files are corrupt", async () => {
    await writeFile(join(home, ".claude.json"), "{not json");
    expect(await discoverMcpConfigs({ home, projectDir: project })).toEqual([]);
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

describe("scanTranscriptTools", () => {
  const line = (names: string[]) => JSON.stringify({ attachment: { type: "deferred_tools_delta", addedNames: names } });

  it("collects mcp__ names from deferred_tools_delta attachments only, skipping excluded servers", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: "mcp__noise__tool" }),
      line(["Read", "mcp__claude_ai_Slack__slack_send_message", "mcp__live__t1", "mcp__project-brain__search_context"]),
      "not json deferred_tools_delta",
      line(["mcp__claude_ai_Slack__slack_send_message", "mcp__figma__authenticate"]),
    ];
    await writeFile(join(home, ".claude", "projects", "p1", "s.jsonl"), lines.join("\n"));

    const tools = await scanTranscriptTools(new Set(["live"]), home);
    expect(tools.map((t) => t.name).sort()).toEqual(["mcp__claude_ai_Slack__slack_send_message", "mcp__figma__authenticate"]);
    const slack = tools.find((t) => t.server === "claude_ai_Slack")!;
    expect(slack.description).toBe("Slack: slack send message");
    expect(slack.nameOnly).toBe(true);
  });

  it("only reads the newest 20 transcripts", async () => {
    const dir = join(home, ".claude", "projects", "p1");
    for (let i = 0; i < 22; i++) {
      const file = join(dir, `s${i}.jsonl`);
      await writeFile(file, line([`mcp__srv${i}__t`]));
      await utimes(file, new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    const tools = await scanTranscriptTools(new Set(), home);
    expect(tools).toHaveLength(20);
    expect(tools.some((t) => t.server === "srv0" || t.server === "srv1")).toBe(false);
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
});

describe("buildCatalog / refreshCatalog", () => {
  const lister = async (s: { name: string }): Promise<ToolEntry[]> => [{ name: `mcp__${s.name}__go`, server: s.name, description: "does a thing" }];

  it("adds transcript names only for servers not listed live, and persists the cache", async () => {
    await json(join(home, ".claude.json"), { mcpServers: { live: { command: "x" } } });
    await writeFile(
      join(home, ".claude", "projects", "p1", "s.jsonl"),
      JSON.stringify({ attachment: { type: "deferred_tools_delta", addedNames: ["mcp__live__other", "mcp__claude_ai_Slack__slack_read"] } })
    );
    const summary = await refreshCatalog({ home, projectDir: project, cacheDir: cache, lister, now: () => 5 });
    expect(summary.catalog.tools.map((t) => t.name)).toEqual(["mcp__live__go", "mcp__claude_ai_Slack__slack_read"]);
    expect(await readCatalogFile(cache)).toEqual(summary.catalog);
    expect(summary.catalog.builtAt).toBe(5);
  });

  it("builds without persisting", async () => {
    const summary = await buildCatalog({ home, projectDir: project, cacheDir: cache, lister });
    expect(summary.catalog.tools).toEqual([]);
    expect(await readCatalogFile(cache)).toBeNull();
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
    await mkdir(cache, { recursive: true });
    const tools = [{ name: "mcp__a__b", server: "a", description: "d" }];
    await json(join(cache, "tool-catalog.json"), { builtAt: 0, fingerprint: "old", tools });
    let spawns = 0;
    const base = { home, projectDir: project, cacheDir: cache, spawn: () => void spawns++ };

    expect(await loadCatalogForHook({ ...base, now: () => 1_000_000 })).toEqual(tools);
    expect(spawns).toBe(1);
    await loadCatalogForHook({ ...base, now: () => 1_000_000 + SPAWN_INTERVAL_MS - 1000 });
    expect(spawns).toBe(1);
    await loadCatalogForHook({ ...base, now: () => 1_000_000 + SPAWN_INTERVAL_MS + 1000 });
    expect(spawns).toBe(2);
  });

  it("does not spawn when the cache is fresh and matches the configs", async () => {
    const fingerprint = fingerprintConfigs(await discoverMcpConfigs({ home, projectDir: project }));
    await mkdir(cache, { recursive: true });
    await json(join(cache, "tool-catalog.json"), { builtAt: 1000, fingerprint, tools: [] });
    let spawns = 0;
    await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, now: () => 2000, spawn: () => void spawns++ });
    expect(spawns).toBe(0);
  });

  it("spawns with no cache at all and returns []", async () => {
    let spawns = 0;
    const out = await loadCatalogForHook({ home, projectDir: project, cacheDir: cache, spawn: () => void spawns++ });
    expect(out).toEqual([]);
    expect(spawns).toBe(1);
  });
});

describe("refreshCommand", () => {
  it("passes the script path under bun and nothing extra for a compiled binary", () => {
    expect(refreshCommand("/usr/local/bin/bun", "/x/cli.ts")).toEqual(["/usr/local/bin/bun", "/x/cli.ts", "tool-catalog", "refresh"]);
    expect(refreshCommand("/usr/local/bin/project-brain", "/$bunfs/root/pb")).toEqual(["/usr/local/bin/project-brain", "tool-catalog", "refresh"]);
  });
});
