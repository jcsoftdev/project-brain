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

/** A fake `$` and `on`: env, files and the CLI answer, with every process call recorded. */
function harness(opts: { env?: Record<string, string>; files?: Record<string, string>; cli?: (argv: string[], stdin?: string) => any }) {
  const handlers = new Map<string, Handler>();
  const runs: Array<{ argv: string[]; stdin?: string }> = [];
  const env: Record<string, string> = { HOME: "/home/u", ...opts.env };
  const files: Record<string, string> = opts.files ?? {};
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path]!;
      },
      exists: async (path: string) => path in files,
    },
    clock: { now: async () => NOW },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        runs.push({ argv, stdin: init?.stdin });
        return opts.cli ? opts.cli(argv, init?.stdin) : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
  mod.register((event: string, ...rest: any[]) => {
    const fn = rest[rest.length - 1] as Handler;
    const matcher = rest.length > 1 ? rest[0] : {};
    handlers.set(`${event}${JSON.stringify(matcher)}`, fn);
    return { catch: () => {} };
  });
  const call = (key: string, e: any) => handlers.get(key)!($, e, async (x: any) => x);
  return { call, runs };
}

const READY = {
  env: { TYPESAFE_API_KEY: "t" },
  files: { "/home/u/.claude/settings.json": '{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"project-brain suggest --stdin"}]}]}}' },
};
const ATTACHMENT = '{"type":"skill_listing"}';
const AGENT = '{"tool":"Agent"}';

describe("the mod's hooks", () => {
  it("rewrites the main loop's listing to names only when the picker is ready", async () => {
    const { call } = harness(READY);
    const out = await call(`prompt.attachment${ATTACHMENT}`, { type: "skill_listing", text: listing, origin: { kind: "engine" } });
    expect(mod.parseListing(out.text)).toBeNull();
    expect(visibleNames(out.text)).toEqual([...fixtureNames()].sort());
  });

  it("rewrites a subagent loop's listing the same way, without the suggest hook", async () => {
    const { call } = harness({ env: { TYPESAFE_API_KEY: "t" } });
    const out = await call(`prompt.attachment${ATTACHMENT}`, { type: "skill_listing", text: listing, origin: { kind: "engine" }, agentId: "a1" });
    expect(mod.parseListing(out.text)).toBeNull();
  });

  it("keeps general-use skills in full in every loop", async () => {
    const files = { ...READY.files, "/home/u/.project-brain/skills.json": JSON.stringify({ general: ["dataviz"] }) };
    const { call } = harness({ ...READY, files });
    for (const agentId of [undefined, "a1"]) {
      const out = await call(`prompt.attachment${ATTACHMENT}`, { type: "skill_listing", text: listing, origin: { kind: "engine" }, agentId });
      expect(mod.parseListing(out.text)!.entries.map((e) => e.name)).toEqual(["dataviz"]);
    }
  });

  it("without a token and without usage numbers, passes the listing through", async () => {
    const { call } = harness({ files: READY.files });
    const out = await call(`prompt.attachment${ATTACHMENT}`, { type: "skill_listing", text: listing, origin: { kind: "engine" } });
    expect(out.text).toBe(listing);
  });

  it("without a token, falls back to the usage numbers", async () => {
    const files = { "/home/u/.project-brain/skill-usage.json": JSON.stringify(usage({ dataviz: { count: 4, lastUsed: NOW - 20 * DAY } })) };
    const { call } = harness({ files });
    const out = await call(`prompt.attachment${ATTACHMENT}`, { type: "skill_listing", text: listing, origin: { kind: "engine" } });
    expect(mod.parseListing(out.text)!.entries.map((e) => e.name)).toEqual(["brain-okf", "brain-style", "dataviz"]);
  });

  it("leaves a listing it did not author alone", async () => {
    const { call } = harness(READY);
    const e = { type: "skill_listing", text: listing, origin: { kind: "hook", event: "SessionStart" } };
    expect(await call(`prompt.attachment${ATTACHMENT}`, e)).toBe(e);
  });

  it("appends the delegation's picked skills to the Agent prompt", async () => {
    const block = "Skills for this task:\nSuggested skill: vercel:nextjs — Next.js guidance\n";
    const { call, runs } = harness({ ...READY, cli: () => ({ exitCode: 0, stdout: block, stderr: "" }) });
    const out = await call(`tool.call${AGENT}`, { tool: "Agent", prompt: "Build the page", description: "Landing page", subagent_type: "general-purpose" });
    expect(out.prompt).toBe(`Build the page\n\n${block.trim()}`);
    expect(out.subagent_type).toBe("general-purpose");
    expect(runs[0]!.argv).toEqual(["project-brain", "suggest", "--agent", "--stdin"]);
    expect(JSON.parse(runs[0]!.stdin!)).toEqual({ prompt: "Build the page", description: "Landing page" });
  });

  it("fails open: an empty answer, a failing CLI, or no token leave the delegation unchanged", async () => {
    const e = { tool: "Agent", prompt: "Build the page", description: "Landing page" };
    for (const cli of [() => ({ exitCode: 0, stdout: "  \n", stderr: "" }), () => ({ exitCode: 1, stdout: "boom", stderr: "" }), () => { throw new Error("timeout"); }]) {
      const { call } = harness({ ...READY, cli });
      expect((await call(`tool.call${AGENT}`, e)).prompt).toBe("Build the page");
    }
    const noToken = harness({ files: READY.files });
    expect((await noToken.call(`tool.call${AGENT}`, e)).prompt).toBe("Build the page");
    expect(noToken.runs).toEqual([]);
  });
});
