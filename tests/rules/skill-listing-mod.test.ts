import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Config = { picker: boolean; general: string[]; keepTop: number; keepRecentDays: number };
type Usage = { generatedAt: number; windowDays: number; skills: Record<string, { count: number; lastUsed: number }> };
type Mode = "jev" | "stats";
type Handler = (...args: any[]) => Promise<any>;

/** The mod's own module, loaded by a computed path so the repo's tsc never type-checks the template against the engine's types. */
interface ModModule {
  DEFAULT_CONFIG: Config;
  OTHER_SKILLS_PREFIX: string;
  parseListing(text: string): { preamble: string[]; entries: Array<{ name: string; lines: string[] }> } | null;
  compactListing(text: string, keep: ReadonlySet<string>): string;
  keepSet(listed: string[], mode: Mode, config: Config, usage: Usage | null, now: number): Set<string>;
  rewriteListing(text: string, mode: Mode, config: Config, usage: Usage | null, now: number): string;
  parseUsage(text: string): Usage | null;
  tokenShaped(envToken: string | undefined, fileText: string): boolean;
  suggestHookActive(settingsText: string): boolean;
  picksHealthy(text: string): boolean;
  listedDescriptions(text: string): Record<string, string>;
  withDelegationSkills(prompt: string, block: string): string;
  register(on: (event: string, ...rest: any[]) => { catch: (fn: Handler) => void }): void;
}

const MOD_PATH = join(import.meta.dir, "../../templates/claude-tui/skill-listing/hooks/register.tsx");
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");

let mod: ModModule;
let listing: string;
beforeAll(async () => {
  mod = (await import(MOD_PATH)) as ModModule;
  listing = await readFile(join(import.meta.dir, "../fixtures/skill-listing.txt"), "utf8");
});

const usage = (skills: Usage["skills"]): Usage => ({ generatedAt: NOW, windowDays: 30, skills });

/** Every name the model can still see: full entries plus the trailing name-only line. */
function visibleNames(text: string): string[] {
  const full = (mod.parseListing(text)?.entries ?? []).map((e) => e.name);
  const other = text
    .split("\n")
    .filter((l) => l.startsWith(mod.OTHER_SKILLS_PREFIX))
    .flatMap((l) => l.slice(mod.OTHER_SKILLS_PREFIX.length).split(", "));
  return [...full, ...other].sort();
}

const fixtureNames = () => mod.parseListing(listing)!.entries.map((e) => e.name);

describe("parseListing on a real-shaped listing", () => {
  it("reads every entry form: plain, plugin:name, aliased, name-only and multi-line", () => {
    const parsed = mod.parseListing(listing)!;
    expect(parsed.entries.map((e) => e.name)).toEqual([
      "brain-okf",
      "brain-style",
      "chained-pr",
      "caveman:caveman-commit",
      "engram:memory",
      "superpowers:brainstorming",
      "vercel:ai-sdk",
      "vercel:nextjs",
      "dataviz",
      "simplify",
      "loop",
      "claude-api",
      "security-review",
    ]);
    expect(parsed.entries.find((e) => e.name === "claude-api")!.lines.filter((l) => l.trim() !== "")).toHaveLength(3);
  });
});

describe("rewriteListing", () => {
  it("golden: jev mode keeps only the general-use skills in full and names the rest on one line", () => {
    const config = { ...mod.DEFAULT_CONFIG, general: ["chained-pr", "not-installed"] };
    const out = mod.rewriteListing(listing, "jev", config, null, NOW);
    const chained = listing.split("\n").find((l) => l.startsWith("- chained-pr:"))!;
    expect(out).toBe(
      [
        chained,
        `${mod.OTHER_SKILLS_PREFIX}brain-okf, brain-style, caveman:caveman-commit, engram:memory, superpowers:brainstorming, vercel:ai-sdk, vercel:nextjs, dataviz, simplify, loop, claude-api, security-review`,
      ].join("\n")
    );
  });

  it("jev mode drops the brain-* core: with nothing general, every skill is a name", () => {
    const out = mod.rewriteListing(listing, "jev", mod.DEFAULT_CONFIG, usage({ "brain-okf": { count: 50, lastUsed: NOW } }), NOW);
    expect(mod.parseListing(out)).toBeNull();
    expect(visibleNames(out)).toEqual([...fixtureNames()].sort());
  });

  it("stats mode keeps general, brain-*, the top N and the recently used, in listing order", () => {
    const config = { ...mod.DEFAULT_CONFIG, general: ["simplify"], keepTop: 1 };
    const stats = usage({
      dataviz: { count: 9, lastUsed: NOW - 20 * DAY },
      loop: { count: 1, lastUsed: NOW - 2 * DAY },
      "vercel:nextjs": { count: 2, lastUsed: NOW - 20 * DAY },
      clear: { count: 99, lastUsed: NOW },
    });
    const out = mod.rewriteListing(listing, "stats", config, stats, NOW);
    expect(mod.parseListing(out)!.entries.map((e) => e.name)).toEqual(["brain-okf", "brain-style", "dataviz", "simplify", "loop"]);
    expect(out).not.toContain("- claude-api: Reference for the Claude API");
    expect(visibleNames(out)).toEqual([...fixtureNames()].sort());
  });

  it("stats mode without usage numbers passes the text through", () => {
    expect(mod.rewriteListing(listing, "stats", mod.DEFAULT_CONFIG, null, NOW)).toBe(listing);
  });

  it("every name survives in both modes", () => {
    const stats = usage({ dataviz: { count: 3, lastUsed: NOW } });
    for (const mode of ["jev", "stats"] as const) {
      expect(visibleNames(mod.rewriteListing(listing, mode, mod.DEFAULT_CONFIG, stats, NOW))).toEqual([...fixtureNames()].sort());
    }
  });

  it("fails open on garbage: text without entries comes back unchanged", () => {
    for (const garbage of ["", "no skills here", "{\"json\": true}", "-not-an-entry\n  - also: not"]) {
      expect(mod.rewriteListing(garbage, "jev", mod.DEFAULT_CONFIG, null, NOW)).toBe(garbage);
    }
  });

  it("returns the text unchanged when every skill is kept", () => {
    const config = { ...mod.DEFAULT_CONFIG, general: fixtureNames() };
    expect(mod.rewriteListing(listing, "jev", config, null, NOW)).toBe(listing);
  });
});

describe("readiness checks", () => {
  it("treats thin usage as no usage, so the listing passes through", () => {
    expect(mod.parseUsage(JSON.stringify(usage({ dataviz: { count: 3, lastUsed: NOW } })))).toBeNull();
    expect(mod.parseUsage(JSON.stringify(usage({ dataviz: { count: 10, lastUsed: NOW } })))).not.toBeNull();
  });

  it("accepts only a token of the right shape", () => {
    expect(mod.tokenShaped(undefined, "")).toBe(false);
    expect(mod.tokenShaped(undefined, '{"token":""}')).toBe(false);
    expect(mod.tokenShaped(undefined, "{garbage")).toBe(false);
    expect(mod.tokenShaped("has space inside", "")).toBe(false);
    expect(mod.tokenShaped(undefined, '{"token":"ts_live_abcdef123"}')).toBe(true);
    expect(mod.tokenShaped("ts_live_abcdef123", "")).toBe(true);
  });

  it("sees the suggest hook only when installed and hooks are not disabled", () => {
    const installed = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "project-brain suggest --stdin" }] }] } };
    expect(mod.suggestHookActive(JSON.stringify(installed))).toBe(true);
    expect(mod.suggestHookActive(JSON.stringify({ ...installed, disableAllHooks: true }))).toBe(false);
    expect(mod.suggestHookActive(JSON.stringify({ note: "project-brain suggest" }))).toBe(false);
    expect(mod.suggestHookActive("{nope")).toBe(false);
  });

  it("stops trusting picks after three failures in a row", () => {
    expect(mod.picksHealthy("")).toBe(true);
    expect(mod.picksHealthy('{"failures":2}')).toBe(true);
    expect(mod.picksHealthy('{"failures":3}')).toBe(false);
  });

  it("records each listed description, alias and continuation lines handled", () => {
    const described = mod.listedDescriptions(listing);
    expect(Object.keys(described)).toHaveLength(13);
    expect(described["engram:memory"]).toStartWith("ALWAYS ACTIVE");
    expect(described["security-review"]).toBe("");
    expect(described["claude-api"]!.split("\n")).toHaveLength(3);
  });

  it("puts the delegation's skills block before its prompt", () => {
    expect(mod.withDelegationSkills("Do X.\nReport in JSON.", "Skills:\nSuggested skill: a — b\n")).toBe("Skills:\nSuggested skill: a — b\n\nDo X.\nReport in JSON.");
    expect(mod.withDelegationSkills("Do X.", "  \n")).toBe("Do X.");
  });
});

const TOKEN = '{"token":"ts_live_abcdef123"}';
const SETTINGS = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "project-brain suggest --stdin" }] }] } });

/** A fake `$` and `on`: env, files and the CLI answer, with every process call and write recorded. */
function harness(opts: { env?: Record<string, string>; files?: Record<string, string>; cli?: (argv: string[], stdin?: string) => any }) {
  const handlers = new Map<string, Handler>();
  const runs: Array<{ argv: string[]; stdin?: string }> = [];
  const env: Record<string, string> = { HOME: "/home/u", ...opts.env };
  const files: Record<string, string> = { ...opts.files };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path]!;
      },
      exists: async (path: string) => path in files,
      write: async (path: string, text: string) => void (files[path] = text),
    },
    clock: { now: async () => NOW, sleep: (ms: number) => Bun.sleep(ms) },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        runs.push({ argv, stdin: init?.stdin });
        return opts.cli ? opts.cli(argv, init?.stdin) : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
  mod.register((event: string, ...rest: any[]) => {
    const fn = rest[rest.length - 1] as Handler;
    const matcher = rest.length > 1 ? rest[0] : undefined;
    handlers.set(matcher ? `${event}${JSON.stringify(matcher)}` : event, fn);
    return { catch: () => {} };
  });
  const call = (key: string, e: any, next: (x: any) => Promise<any> = async (x) => x) => handlers.get(key)!($, e, next);
  return { call, runs, files };
}

const READY = { files: { "/home/u/.project-brain/reranker.json": TOKEN, "/home/u/.claude/settings.json": SETTINGS } };
const LISTING = 'prompt.attachment{"type":"skill_listing"}';
const attachment = (agentId?: string) => ({ type: "skill_listing", text: listing, origin: { kind: "engine" }, ...(agentId ? { agentId } : {}) });
const BLOCK = "Skills for this task:\nSuggested skill: vercel:nextjs — Next.js guidance\n";
const answers = (stdout: string) => () => ({ exitCode: 0, stdout, stderr: "" });

describe("the mod's hooks", () => {
  it("rewrites the main loop's listing to names only when the picker is ready", async () => {
    const { call } = harness(READY);
    const out = await call(LISTING, attachment());
    expect(mod.parseListing(out.text)).toBeNull();
    expect(visibleNames(out.text)).toEqual([...fixtureNames()].sort());
  });

  it("records the listed descriptions for the picker", async () => {
    const { call, files } = harness(READY);
    await call(LISTING, attachment());
    expect(Object.keys(JSON.parse(files["/home/u/.project-brain/skill-listing.json"]!).skills)).toContain("engram:memory");
  });

  it("keeps descriptions after three failed picks in a row", async () => {
    const { call } = harness({ files: { ...READY.files, "/home/u/.project-brain/skill-pick-health.json": '{"failures":3}' } });
    expect((await call(LISTING, attachment())).text).toBe(listing);
  });

  it("keeps descriptions when hooks are disabled or the token is malformed", async () => {
    for (const files of [
      { ...READY.files, "/home/u/.claude/settings.json": JSON.stringify({ ...JSON.parse(SETTINGS), disableAllHooks: true }) },
      { ...READY.files, "/home/u/.project-brain/reranker.json": '{"token":""}' },
    ]) {
      const { call } = harness({ files });
      expect((await call(LISTING, attachment())).text).toBe(listing);
    }
  });

  it("names only in a subagent whose spawn carried a skills block, placed before the prompt", async () => {
    const { call } = harness({ ...READY, cli: answers(BLOCK) });
    const spawned: any[] = [];
    await call("agent.spawn", { tool_use_id: "t1", prompt: "Build the page", description: "Landing" }, async (e) => (spawned.push(e), { model: "m", agentId: "a1" }));
    expect(spawned[0].prompt).toBe(`${BLOCK.trim()}\n\nBuild the page`);
    expect(mod.parseListing((await call(LISTING, attachment("a1"))).text)).toBeNull();
  });

  it("waits for a spawn still resolving its id before deciding", async () => {
    const { call } = harness({ ...READY, cli: answers(BLOCK) });
    let resolveSpawn: (v: any) => void = () => {};
    const spawning = call("agent.spawn", { tool_use_id: "t2", prompt: "P", description: "D" }, () => new Promise((r) => (resolveSpawn = r)));
    await Bun.sleep(5);
    const listed = call(LISTING, attachment("a2"));
    resolveSpawn({ model: "m", agentId: "a2" });
    await spawning;
    expect(mod.parseListing((await listed).text)).toBeNull();
  });

  it("a subagent nothing was picked for gets the usage-mode listing, and its spawn goes out unchanged", async () => {
    const stats = JSON.stringify(usage({ dataviz: { count: 12, lastUsed: NOW - 20 * DAY } }));
    const { call } = harness({ files: { ...READY.files, "/home/u/.project-brain/skill-usage.json": stats }, cli: answers("\n") });
    const e = { tool_use_id: "t3", prompt: "Build the page", description: "Landing" };
    const spawned: any[] = [];
    await call("agent.spawn", e, async (x) => (spawned.push(x), { model: "m", agentId: "a3" }));
    expect(spawned[0]).toBe(e);
    const out = await call(LISTING, attachment("a3"));
    expect(mod.parseListing(out.text)!.entries.map((x) => x.name)).toEqual(["brain-okf", "brain-style", "dataviz"]);
  });

  it("a subagent no spawn of ours carried skills for keeps descriptions without usage numbers", async () => {
    const { call } = harness(READY);
    expect((await call(LISTING, attachment("teammate"))).text).toBe(listing);
  });

  it("keeps general-use skills in full in every loop", async () => {
    const files = { ...READY.files, "/home/u/.project-brain/skills.json": JSON.stringify({ general: ["dataviz"] }) };
    const { call } = harness({ files, cli: answers(BLOCK) });
    await call("agent.spawn", { tool_use_id: "t4", prompt: "P", description: "D" }, async () => ({ model: "m", agentId: "a4" }));
    for (const agentId of [undefined, "a4"]) {
      expect(mod.parseListing((await call(LISTING, attachment(agentId))).text)!.entries.map((x) => x.name)).toEqual(["dataviz"]);
    }
  });

  it("without a token, falls back to the usage numbers", async () => {
    const files = { "/home/u/.project-brain/skill-usage.json": JSON.stringify(usage({ dataviz: { count: 12, lastUsed: NOW - 20 * DAY } })) };
    const { call } = harness({ files });
    expect(mod.parseListing((await call(LISTING, attachment())).text)!.entries.map((x) => x.name)).toEqual(["brain-okf", "brain-style", "dataviz"]);
  });

  it("leaves a listing it did not author alone", async () => {
    const { call } = harness(READY);
    const e = { type: "skill_listing", text: listing, origin: { kind: "hook", event: "SessionStart" } };
    expect(await call(LISTING, e)).toBe(e);
  });

  it("sends the delegation's prompt and description to the CLI", async () => {
    const { call, runs } = harness({ ...READY, cli: answers(BLOCK) });
    await call("agent.spawn", { tool_use_id: "t5", prompt: "Build the page", description: "Landing page" }, async () => ({ model: "m" }));
    expect(runs[0]!.argv).toEqual(["project-brain", "suggest", "--agent", "--stdin"]);
    expect(JSON.parse(runs[0]!.stdin!)).toEqual({ prompt: "Build the page", description: "Landing page" });
  });

  it("fails open: an empty answer, a failing CLI, a throw, or no token leave the spawn unchanged", async () => {
    const e = { tool_use_id: "t6", prompt: "Build the page", description: "Landing page" };
    const failures = [answers("  \n"), () => ({ exitCode: 1, stdout: "boom", stderr: "" }), () => { throw new Error("timeout"); }];
    for (const cli of failures) {
      const { call } = harness({ ...READY, cli });
      const seen: any[] = [];
      await call("agent.spawn", e, async (x) => (seen.push(x), { model: "m" }));
      expect(seen[0]).toBe(e);
    }
    const noToken = harness({ files: { "/home/u/.claude/settings.json": SETTINGS } });
    const seen: any[] = [];
    await noToken.call("agent.spawn", e, async (x) => (seen.push(x), { model: "m" }));
    expect(seen[0]).toBe(e);
    expect(noToken.runs).toEqual([]);
  });
});

