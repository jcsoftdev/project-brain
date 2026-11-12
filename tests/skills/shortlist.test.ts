import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingClient } from "../../src/types.js";
import { DEFAULT_SKILLS_CONFIG } from "../../src/skills/config.js";
import type { SkillInfo } from "../../src/skills/discovery.js";
import { LISTED_SKILLS_FILE, PICK_HEALTH_FILE, recordPickHealth, withListedSkills } from "../../src/skills/listed.js";
import { isProcessSkill, MAX_SKILL_CANDIDATES, pickSkill } from "../../src/skills/picker.js";
import type { SharedQuery } from "../../src/skills/semantic.js";
import { jevReply } from "../helpers/jev-fake.js";

/**
 * Cosines measured with qwen3-embedding:0.6b on 135 installed skills: for "arregla este bug del
 * parser" systematic-debugging scored 0.541 (#2), under the old 0.67 floor; for "construye una
 * feature nueva de login" brainstorming scored 0.463 (#58), below a dozen domain skills.
 */
const COSINES: Record<string, number> = {
  "superpowers:systematic-debugging": 0.541,
  "superpowers:brainstorming": 0.2,
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`domain-${i}`, 0.6 - i * 0.005])),
};

const SKILLS: SkillInfo[] = [
  { name: "superpowers:systematic-debugging", description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes" },
  { name: "superpowers:brainstorming", description: "You MUST use this before any creative work - creating features, building components" },
  ...Array.from({ length: 20 }, (_, i) => ({ name: `domain-${i}`, description: `Framework guidance number ${i}` })),
];

/** 2-D vectors whose cosine to the prompt vector [1, 0] is the measured one. */
function fakeEmbeddings(): EmbeddingClient {
  return {
    dim: 2,
    model: "fake",
    isAvailable: async () => true,
    embed: async (texts) =>
      texts.map((text) => {
        const cos = COSINES[text.split(": ")[0]!] ?? 0;
        return [cos, Math.sqrt(1 - cos * cos)];
      }),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-shortlist-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function shortlistFor(prompt: string, skills: SkillInfo[] = SKILLS, shared: SharedQuery | null = { embeddings: fakeEmbeddings(), vector: [1, 0] }) {
  let sent: string[] = [];
  await pickSkill(prompt, {
    projectDir: "/p",
    env: {},
    getToken: async () => "tok",
    discover: async () => skills,
    skillsConfig: DEFAULT_SKILLS_CONFIG,
    queryEmbedding: async () => shared,
    vectorCacheDir: dir,
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      sent = body.state.skills.map((s: { name: string }) => s.name);
      return jevReply(body, {});
    },
  });
  return sent;
}

describe("skill shortlist", () => {
  it("shortlists systematic-debugging for a bug prompt although it scores under the old floor", async () => {
    expect(await shortlistFor("arregla este bug del parser")).toContain("superpowers:systematic-debugging");
  });

  it("shortlists brainstorming for a feature prompt although a dozen skills outrank it", async () => {
    const sent = await shortlistFor("construye una feature nueva de login");
    expect(sent).toContain("superpowers:brainstorming");
    expect(sent.filter((name) => name.startsWith("domain-"))).toHaveLength(MAX_SKILL_CANDIDATES);
  });

  it("falls back to keywords when nothing ranks, and still adds the process skills", async () => {
    const empty: EmbeddingClient = { dim: 2, model: "none", isAvailable: async () => true, embed: async () => null as never };
    const sent = await shortlistFor("framework guidance please", SKILLS, { embeddings: empty, vector: [1, 0] });
    expect(sent).toContain("domain-0");
    expect(sent).toContain("superpowers:brainstorming");
  });

  it("tells process skills from domain ones by how the description opens", () => {
    expect(isProcessSkill(SKILLS[0]!)).toBe(true);
    expect(isProcessSkill(SKILLS[1]!)).toBe(true);
    expect(isProcessSkill({ description: "Users of this framework" })).toBe(false);
    expect(isProcessSkill({ description: "Used whenever" })).toBe(false);
  });
});

describe("skills without a SKILL.md", () => {
  it("join the candidates from the listing the mod recorded, unless discovery found them", () => {
    const merged = withListedSkills([{ name: "brain-style", description: "on disk" }], { "brain-style": "listed", dataviz: "Use this skill whenever you chart" });
    expect(merged.map((s) => [s.name, s.description])).toEqual([
      ["brain-style", "on disk"],
      ["dataviz", "Use this skill whenever you chart"],
    ]);
    expect(merged[1]!.path).toBe("listing:dataviz");
  });

  it("are read by the default discovery from the data dir", async () => {
    await writeFile(join(dir, LISTED_SKILLS_FILE), JSON.stringify({ skills: { dataviz: "Charts and dashboards for chart prompts" } }));
    let sent: string[] = [];
    await pickSkill("make a chart dashboard", {
      projectDir: dir,
      env: {},
      getToken: async () => "tok",
      skillsConfig: DEFAULT_SKILLS_CONFIG,
      discoverOptions: { projectDir: dir, home: dir, cacheDir: dir },
      queryEmbedding: async () => null,
      fetchFn: async (_url, init) => {
        const body = JSON.parse(init.body as string);
        sent = body.state.skills.map((s: { name: string }) => s.name);
        return jevReply(body, {});
      },
    });
    expect(sent).toEqual(["dataviz"]);
  });
});

describe("pick health", () => {
  it("counts failures in a row and resets on a success", async () => {
    expect((await recordPickHealth(dir, false, 1)).failures).toBe(1);
    expect((await recordPickHealth(dir, false, 2)).failures).toBe(2);
    expect(await recordPickHealth(dir, true, 3)).toEqual({ failures: 0, lastSuccess: 3, lastFailure: 2 });
    expect(JSON.parse(await readFile(join(dir, PICK_HEALTH_FILE), "utf8")).failures).toBe(0);
  });

  it("is reported for a skill request, answered or not", async () => {
    const seen: boolean[] = [];
    const base = {
      projectDir: "/p",
      env: {},
      getToken: async () => "tok",
      discover: async () => SKILLS,
      skillsConfig: DEFAULT_SKILLS_CONFIG,
      queryEmbedding: async () => null,
      recordHealth: async (ok: boolean) => void seen.push(ok),
    };
    await pickSkill("fix this bug please", { ...base, fetchFn: async (_u, init) => jevReply(JSON.parse(init.body as string), {}) });
    await pickSkill("fix this bug please", { ...base, fetchFn: async () => new Response("down", { status: 503 }) });
    expect(seen).toEqual([true, false]);
  });
});
