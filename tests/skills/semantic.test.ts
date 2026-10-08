import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearch } from "../../src/commands/search.js";
import { NullEmbeddingClient } from "../../src/embeddings/null.js";
import { pickSkill } from "../../src/skills/picker.js";
import { cosine, rankSkillsSemantic, type SharedQuery } from "../../src/skills/semantic.js";
import type { SkillInfo } from "../../src/skills/discovery.js";
import type { EmbeddingClient, VectorStore } from "../../src/types.js";

const SKILLS: SkillInfo[] = [
  { name: "brain-commit", description: "Writes a git commit message", path: "/s/commit/SKILL.md", mtime: 1 },
  { name: "tailwind", description: "Tailwind CSS design tokens", path: "/s/tw/SKILL.md", mtime: 1 },
  { name: "other", description: "Something unrelated", path: "/s/other/SKILL.md", mtime: 1 },
];

/** Places Spanish and English commit wording on the same axis, like a multilingual model would. */
function vec(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes("commit") || t.includes("mensaje")) return [1, 0, 0];
  if (t.includes("tailwind")) return [0, 1, 0];
  return [0, 0, 1];
}

function fakeEmbeddings(model = "fake-model") {
  const calls: string[][] = [];
  const client: EmbeddingClient = {
    dim: 3,
    model,
    isAvailable: async () => true,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map(vec);
    },
  };
  return { client, calls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-sem-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ES_PROMPT = "escribe el mensaje del commit para estos cambios";

function jev(choice: string) {
  const calls: any[] = [];
  return {
    calls,
    fetchFn: async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({ answers: { pick: { choice, confidence: 0.9, probabilities: { [choice]: 0.9, none: 0.1 } } } })
      );
    },
  };
}

describe("semantic shortlist", () => {
  it("ranks by cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("a Spanish prompt reaches English skills and yields a suggestion", async () => {
    const { client } = fakeEmbeddings();
    const shared: SharedQuery = { embeddings: client, vector: vec(ES_PROMPT) };
    const j = jev("brain-commit");

    const line = await pickSkill(ES_PROMPT, {
      projectDir: "/p",
      env: {},
      getToken: async () => "tok",
      discover: async () => SKILLS,
      queryEmbedding: async () => shared,
      vectorCacheDir: dir,
      fetchFn: j.fetchFn,
    });

    // The keyword prefilter shares no word with this prompt; only embeddings can find the skill.
    expect(line).toStartWith("Suggested skill: brain-commit");
    expect(j.calls).toHaveLength(1);
    expect(j.calls[0].state.skills[0].name).toBe("brain-commit");
  });

  it("embeds each skill once and reuses cached vectors", async () => {
    const { client, calls } = fakeEmbeddings();
    const shared: SharedQuery = { embeddings: client, vector: [1, 0, 0] };

    await rankSkillsSemantic(SKILLS, shared, 2, dir);
    await rankSkillsSemantic(SKILLS, shared, 2, dir);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(SKILLS.length);
  });

  it("re-embeds only the skill whose mtime changed", async () => {
    const { client, calls } = fakeEmbeddings();
    const shared: SharedQuery = { embeddings: client, vector: [1, 0, 0] };
    await rankSkillsSemantic(SKILLS, shared, 2, dir);

    const edited = SKILLS.map((s) => (s.name === "tailwind" ? { ...s, mtime: 2 } : s));
    await rankSkillsSemantic(edited, shared, 2, dir);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);
    expect(calls[1]![0]).toContain("tailwind");
  });

  it("a different embedding model gets its own vectors", async () => {
    const a = fakeEmbeddings("model-a");
    const b = fakeEmbeddings("model-b");
    await rankSkillsSemantic(SKILLS, { embeddings: a.client, vector: [1, 0, 0] }, 2, dir);
    await rankSkillsSemantic(SKILLS, { embeddings: b.client, vector: [1, 0, 0] }, 2, dir);

    expect(b.calls).toHaveLength(1);
    expect((await readdir(dir)).filter((f) => f.startsWith("skill-vectors-"))).toHaveLength(2);
  });

  it("returns the top N only", async () => {
    const { client } = fakeEmbeddings();
    const top = await rankSkillsSemantic(SKILLS, { embeddings: client, vector: [1, 0, 0] }, 1, dir);
    expect(top!.map((s) => s.name)).toEqual(["brain-commit"]);
  });

  it("returns null when embeddings are unavailable", async () => {
    const shared: SharedQuery = { embeddings: new NullEmbeddingClient(), vector: [1] };
    expect(await rankSkillsSemantic(SKILLS, shared, 2, dir)).toBeNull();
  });

  it("falls back to the keyword prefilter when the shared query is null", async () => {
    const j = jev("brain-commit");
    const base = {
      projectDir: "/p",
      env: {},
      getToken: async () => "tok",
      discover: async () => SKILLS,
      vectorCacheDir: dir,
      fetchFn: j.fetchFn,
    };

    // Spanish prompt, no embeddings → keyword overlap is empty → no call.
    expect(await pickSkill("redacta el mensaje de estos cambios", { ...base, queryEmbedding: async () => null })).toBeNull();
    expect(j.calls).toHaveLength(0);

    // Same fallback still works when the prompt does overlap.
    const line = await pickSkill("write the git commit message", { ...base, queryEmbedding: async () => null });
    expect(line).toStartWith("Suggested skill: brain-commit");
  });
});

describe("similarity floor", () => {
  it("drops skills below the cosine floor, returning [] rather than null", async () => {
    const { client } = fakeEmbeddings();
    const far: SharedQuery = { embeddings: client, vector: [0.5, 0.5, 0.5] }; // cos ~0.58 to every axis
    expect(await rankSkillsSemantic(SKILLS, far, 12, dir)).toEqual([]);
  });

  it("makes no Jev call and prints no line when nothing clears the floor", async () => {
    const { client } = fakeEmbeddings();
    const j = jev("brain-commit");
    const line = await pickSkill("explícame cómo funciona el store", {
      projectDir: "/p",
      env: {},
      getToken: async () => "tok",
      discover: async () => SKILLS,
      queryEmbedding: async () => ({ embeddings: client, vector: [0.5, 0.5, 0.5] }),
      vectorCacheDir: dir,
      fetchFn: j.fetchFn,
    });
    expect(line).toBeNull();
    expect(j.calls).toHaveLength(0);
  });
});

describe("cold-cache warming", () => {
  const many: SkillInfo[] = Array.from({ length: 40 }, (_, i) => ({
    name: `s${i}`,
    description: "commit helper",
    path: `/s/${i}/SKILL.md`,
    mtime: 1,
  }));

  it("persists each batch of at most 16 as soon as it lands", async () => {
    let calls = 0;
    const client: EmbeddingClient = {
      dim: 3,
      model: "warm",
      isAvailable: async () => true,
      embed: async (texts) => {
        calls++;
        if (calls === 2) throw new Error("process died here");
        expect(texts.length).toBeLessThanOrEqual(16);
        return texts.map(vec);
      },
    };
    await rankSkillsSemantic(many, { embeddings: client, vector: [1, 0, 0] }, 12, dir);

    const file = (await readdir(dir)).find((f) => f.startsWith("skill-vectors-"))!;
    const saved = JSON.parse(await readFile(join(dir, file), "utf-8"));
    expect(Object.keys(saved)).toHaveLength(16);
  });

  it("stops warming past the budget and still ranks with what exists", async () => {
    const { client, calls } = fakeEmbeddings("budget");
    let t = 0;
    const top = await rankSkillsSemantic(many, { embeddings: client, vector: [1, 0, 0] }, 12, dir, () => (t += 500));

    expect(calls).toHaveLength(1);
    expect(top!.length).toBe(12);
  });
});

describe("shared prompt vector", () => {
  it("retrieval uses the precomputed vector instead of embedding again", async () => {
    const seen: number[][] = [];
    const store = {
      hybridSearch: async (_p: string, v: number[]) => {
        seen.push(v);
        return [];
      },
      ftsSearch: async () => [],
      assertDim: async () => {},
    } as unknown as VectorStore;
    const { client, calls } = fakeEmbeddings();

    await runSearch({ query: "q", project: "p", limit: 3, queryVector: [9, 9, 9] }, { store, embeddings: client });

    expect(calls).toHaveLength(0);
    expect(seen).toEqual([[9, 9, 9]]);
  });
});
