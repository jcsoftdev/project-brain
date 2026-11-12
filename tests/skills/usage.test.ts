import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../../src/commands/skill-usage.js";
import { DEFAULT_SKILLS_CONFIG, readSkillsConfig, skillsConfigPath, writeGeneralList } from "../../src/skills/config.js";
import { readSkillUsage, refreshSkillUsage, scanSkillUsage, skillUsagePath } from "../../src/skills/usage.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const skillCall = (id: string, skill: string, daysAgo: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: iso(daysAgo),
    message: { content: [{ type: "text", text: "loading" }, { type: "tool_use", id, name: "Skill", input: { skill } }] },
  });
const slash = (uuid: string, name: string, daysAgo: number) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: iso(daysAgo),
    message: { content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>init</command-args>` },
  });

let dir: string;
let projects: string;
let dataDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-skill-usage-"));
  projects = join(dir, "projects");
  dataDir = join(dir, "data");
  await mkdir(join(projects, "-repo", "s1", "subagents"), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function transcript(rel: string, lines: string[], daysAgo = 0) {
  const path = join(projects, rel);
  await writeFile(path, `${lines.join("\n")}\n`);
  const at = new Date(NOW - daysAgo * DAY);
  await utimes(path, at, at);
}

describe("scanSkillUsage", () => {
  it("counts Skill tool calls and slash commands, once per call across resumed copies", async () => {
    await transcript("-repo/s1.jsonl", [
      skillCall("t1", "brain-okf", 2),
      skillCall("t2", "brain-okf", 1),
      slash("u1", "brain-style", 3),
      "{not json but mentions \"name\":\"Skill\"",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Skill", input: {} }] } }),
    ]);
    // A resumed session copies the history it continues: the same ids must not count twice.
    await transcript("-repo/s2.jsonl", [skillCall("t1", "brain-okf", 2), skillCall("t3", "dataviz", 0)]);
    await transcript("-repo/s1/subagents/agent-1.jsonl", [skillCall("t4", "dataviz", 0)]);

    const usage = await scanSkillUsage({ projectsRoot: projects, now: NOW });
    expect(usage.skills).toEqual({
      "brain-okf": { count: 2, lastUsed: NOW - DAY },
      "brain-style": { count: 1, lastUsed: NOW - 3 * DAY },
      dataviz: { count: 2, lastUsed: NOW },
    });
    expect(usage.scanned).toMatchObject({ files: 3, truncated: false });
  });

  it("skips transcripts and calls older than the window", async () => {
    await transcript("-repo/old.jsonl", [skillCall("o1", "ancient", 40)], 40);
    await transcript("-repo/mixed.jsonl", [skillCall("m1", "ancient", 45), skillCall("m2", "fresh", 1)]);
    const usage = await scanSkillUsage({ projectsRoot: projects, now: NOW, windowDays: 30 });
    expect(Object.keys(usage.skills)).toEqual(["fresh"]);
  });

  it("reads newest first and stops at the byte budget", async () => {
    await transcript("-repo/new.jsonl", [skillCall("n1", "newer", 0)], 0);
    await transcript("-repo/older.jsonl", [skillCall("o1", "older", 1)], 1);
    const usage = await scanSkillUsage({ projectsRoot: projects, now: NOW, maxBytes: 300 });
    expect(Object.keys(usage.skills)).toEqual(["newer"]);
    expect(usage.scanned.truncated).toBe(true);
  });

  it("returns an empty result for a missing projects directory", async () => {
    const usage = await scanSkillUsage({ projectsRoot: join(dir, "nope"), now: NOW });
    expect(usage.skills).toEqual({});
  });
});

describe("refreshSkillUsage", () => {
  it("writes once, then skips while the file is under a day old", async () => {
    await transcript("-repo/a.jsonl", [skillCall("t1", "brain-okf", 0)]);
    expect(await refreshSkillUsage({ dataDir, projectsRoot: projects, now: NOW })).not.toBeNull();
    expect((await readSkillUsage(dataDir))?.skills["brain-okf"]?.count).toBe(1);
    expect(await refreshSkillUsage({ dataDir, projectsRoot: projects, now: NOW + DAY / 2 })).toBeNull();
    expect(await refreshSkillUsage({ dataDir, projectsRoot: projects, now: NOW + DAY + 1 })).not.toBeNull();
  });

  it("leaves the scan to a refresh already holding the lock", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${skillUsagePath(dataDir)}.lock`, "");
    expect(await refreshSkillUsage({ dataDir, projectsRoot: projects })).toBeNull();
  });
});

describe("skill-usage command", () => {
  it("is read-only without --write", async () => {
    await transcript("-repo/a.jsonl", [skillCall("t1", "brain-okf", 0)]);
    const out: string[] = [];
    await execute([], { dataDir, projectsRoot: projects, log: (l) => out.push(l) });
    expect(out.join("\n")).toContain("brain-okf");
    expect(await readSkillUsage(dataDir)).toBeNull();
    await execute(["--write"], { dataDir, projectsRoot: projects, log: () => {} });
    expect(await readSkillUsage(dataDir)).not.toBeNull();
  });
});

describe("skills.json", () => {
  it("defaults without a file, reads the file, and lets the env override it", async () => {
    expect(readSkillsConfig(dataDir, {})).toEqual(DEFAULT_SKILLS_CONFIG);
    await mkdir(dataDir, { recursive: true });
    await writeFile(skillsConfigPath(dataDir), JSON.stringify({ picker: true, pickCeiling: 4, general: ["brain-style", 3], keepTop: "x" }));
    expect(readSkillsConfig(dataDir, {})).toEqual({ ...DEFAULT_SKILLS_CONFIG, pickCeiling: 4, general: ["brain-style"] });
    expect(readSkillsConfig(dataDir, { BRAIN_SKILL_PICKER: "0", BRAIN_SKILL_PICK_MAX: "7" })).toMatchObject({ picker: false, pickCeiling: 7 });
  });

  it("garbage reads as the defaults", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(skillsConfigPath(dataDir), "{nope");
    expect(readSkillsConfig(dataDir, {})).toEqual(DEFAULT_SKILLS_CONFIG);
  });

  it("writing the general list keeps every other key", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(skillsConfigPath(dataDir), JSON.stringify({ pickCeiling: 3, mine: true }));
    await writeGeneralList(dataDir, ["b", "a", "a"]);
    expect(JSON.parse(await readFile(skillsConfigPath(dataDir), "utf8"))).toEqual({ pickCeiling: 3, mine: true, general: ["a", "b"] });
  });
});
