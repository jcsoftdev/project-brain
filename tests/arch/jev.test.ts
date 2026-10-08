import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_ARCH_VIOLATION_MIN_PROBABILITY } from "../../src/constants.js";
import { anchorCovers } from "../../src/okf/anchors.js";
import { judgeConstraints, loadCoveringConstraints, type ArchAsk, type CoveringConstraint } from "../../src/arch/jev.js";
import { archGuardDecision, type ArchGuardContext, type JevContext } from "../../src/hooks/arch-guard.js";
import type { ChoiceAnswer, TypesafeFetchFn } from "../../src/typesafe/client.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(concepts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arch-jev-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(concepts)) {
    const path = join(root, "okf", rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

const concept = (type: string, title: string, resource: string | null, body = "Keep it so.") =>
  `---\ntype: ${type}\ntitle: ${title}\n${resource ? `resource: ${resource}\n` : ""}---\n\n${body}\n`;

describe("anchorCovers", () => {
  it("a plain anchor covers exactly its own path", () => {
    expect(anchorCovers({ path: "src/a.ts" }, "src/a.ts")).toBe(true);
    expect(anchorCovers({ path: "src/a.ts" }, "src/a.ts.bak")).toBe(false);
    expect(anchorCovers({ path: "src/domain" }, "src/domain/x.ts")).toBe(false);
  });

  it("a directory anchor covers everything beneath it, and not a sibling that shares the prefix", () => {
    const dir = { path: "src/domain", directory: true as const };
    expect(anchorCovers(dir, "src/domain/x.ts")).toBe(true);
    expect(anchorCovers(dir, "src/domain/deep/y.ts")).toBe(true);
    expect(anchorCovers(dir, "src/domain-extras/z.ts")).toBe(false);
    expect(anchorCovers(dir, "src/domain")).toBe(false);
  });
});

describe("loadCoveringConstraints", () => {
  it("selects Constraint concepts whose directory or file anchor covers the file", async () => {
    const root = await project({
      "constraints/dir.md": concept("Constraint", "No DB in domain", "../src/domain/", "Persistence stays outside."),
      "constraints/file.md": concept("Constraint", "Entity is immutable", "../src/domain/user.ts#User"),
      "constraints/other.md": concept("Constraint", "Elsewhere", "../src/infra/"),
      "constraints/unanchored.md": concept("Constraint", "Floating", null),
      "decisions/dec.md": concept("Decision", "Not a constraint", "../src/domain/"),
    });

    const found = await loadCoveringConstraints(root, "src/domain/user.ts");
    expect(found.map((c) => c.title).sort()).toEqual(["Entity is immutable", "No DB in domain"]);
    expect(found.find((c) => c.title === "No DB in domain")?.body).toBe("Persistence stays outside.");
  });

  it("is empty when the project has no bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "arch-jev-"));
    dirs.push(root);
    expect(await loadCoveringConstraints(root, "src/domain/user.ts")).toEqual([]);
  });
});

const CONSTRAINTS: CoveringConstraint[] = [
  { concept: "constraints/a.md", title: "A", body: "body a" },
  { concept: "constraints/b.md", title: "B", body: "body b" },
];

function answer(yes: number): ChoiceAnswer {
  return { type: "choice", choice: yes > 0.5 ? "yes" : "no", confidence: Math.max(yes, 1 - yes), probabilities: { yes, no: 1 - yes } };
}

describe("loadCoveringConstraints, selection", () => {
  it("treats a directory anchor written without a trailing slash as a directory", async () => {
    const root = await project({ "constraints/d.md": concept("Constraint", "Dir", "../src/domain") });
    await mkdir(join(root, "src", "domain"), { recursive: true });
    expect((await loadCoveringConstraints(root, "src/domain/deep/x.ts")).map((c) => c.title)).toEqual(["Dir"]);
  });

  it("sends at most 10 constraints, the most specific anchors first", async () => {
    const concepts: Record<string, string> = {};
    for (let i = 0; i < 12; i++) concepts[`constraints/broad${i}.md`] = concept("Constraint", `broad${i}`, "../src/");
    concepts["constraints/deep.md"] = concept("Constraint", "deep", "../src/domain/model/");
    concepts["constraints/file.md"] = concept("Constraint", "file", "../src/domain/model/u.ts");
    const root = await project(concepts);

    const found = await loadCoveringConstraints(root, "src/domain/model/u.ts");
    expect(found).toHaveLength(10);
    expect(found.slice(0, 2).map((c) => c.title)).toEqual(["file", "deep"]);
  });
});

describe("judgeConstraints", () => {
  const edit = { tool: "Edit", oldString: "a", newString: "b" };

  it("batches every constraint into ONE ask, carrying title, body, file and the edit", async () => {
    const calls: any[] = [];
    const fake: ArchAsk = async (token, state, questions) => {
      calls.push({ token, state, questions });
      return { c0: answer(0.1), c1: answer(0.1) };
    };
    await judgeConstraints("tok", CONSTRAINTS, "src/domain/u.ts", edit, { ask: fake });

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(["c0", "c1"]);
    expect(Object.keys(calls[0].questions.c0.criteria)).toEqual(["yes", "no"]);
    expect(calls[0].state.file).toBe("src/domain/u.ts");
    expect(calls[0].state.constraints.c1).toEqual({ title: "B", body: "body b" });
    expect(calls[0].state.edit).toEqual({ old: "a", new: "b" });
  });

  it("blocks strictly above the threshold, not at it", async () => {
    const at = JEV_ARCH_VIOLATION_MIN_PROBABILITY;
    const fake: ArchAsk = async () => ({ c0: answer(at), c1: answer(at + 0.01) });
    const v = await judgeConstraints("tok", CONSTRAINTS, "f.ts", edit, { ask: fake });
    expect(v.map((x) => x.title)).toEqual(["B"]);
  });

  it("fails open when Jev gives no answer", async () => {
    expect(await judgeConstraints("tok", CONSTRAINTS, "f.ts", edit, { ask: async () => null })).toEqual([]);
  });

  it("truncates a huge Write before it leaves the machine", async () => {
    let state: any;
    const fake: ArchAsk = async (_t, s) => ((state = s), { c0: answer(0), c1: answer(0) });
    await judgeConstraints("tok", CONSTRAINTS, "f.ts", { tool: "Write", content: "x".repeat(50_000) }, { ask: fake });
    expect(state.edit.newContent.length).toBeLessThan(5000);
  });

  it("goes over the wire as one request, token in the header only, and times out to []", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn: TypesafeFetchFn = async (url, init) => {
      seen.push({ url, init });
      const body = { answers: { c0: answer(0.95), c1: answer(0.05) } };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const v = await judgeConstraints("SECRET-TOKEN", CONSTRAINTS, "f.ts", edit, { fetchFn });

    expect(v.map((x) => x.title)).toEqual(["A"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("api.typesafe.ai");
    expect(String(seen[0]!.init.body)).not.toContain("SECRET-TOKEN");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET-TOKEN");

    const hang: TypesafeFetchFn = (_u, init) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await judgeConstraints("t", CONSTRAINTS, "f.ts", edit, { fetchFn: hang, timeoutMs: 20 })).toEqual([]);
  });
});

describe("archGuardDecision, Jev layer", () => {
  const ROOT = "/proj";
  const files: Record<string, string> = { [`${ROOT}/src/domain/u.ts`]: "export const u = 1;\n" };
  const payload = {
    tool_name: "Edit",
    tool_input: { file_path: `${ROOT}/src/domain/u.ts`, old_string: "u = 1", new_string: "u = db.read()" },
  };

  // Only an explicit "block" blocks; this config enforces nothing but still sets the mode.
  const BLOCK_MODE = { [`${ROOT}/.project-brain/architecture.json`]: '{"mode":"block"}' };

  function ctx(jev: Partial<JevContext> | undefined, extra: Record<string, string> = BLOCK_MODE): ArchGuardContext {
    const all = { ...files, ...extra };
    return {
      findRoot: () => ROOT,
      readFile: (p) => all[p] ?? null,
      exists: (p) => p in all,
      jev: jev && {
        token: async () => "tok",
        constraints: async () => [CONSTRAINTS[0]!],
        now: () => 0,
        ...jev,
      },
    };
  }

  it("blocks when Jev is confident, naming the constraint and how to fix it", async () => {
    const d = await archGuardDecision(payload, ctx({ ask: async () => ({ c0: answer(0.93) }) }));
    expect(d.block).toBe(true);
    expect(d.reason).toContain('"A"');
    expect(d.reason).toContain("okf/constraints/a.md");
    expect(d.reason).toContain("Fix:");
  });

  it("only warns when there is no architecture.json, or its mode is not an explicit block", async () => {
    const confident = { ask: async () => ({ c0: answer(0.99) }) };
    const variants: Record<string, string>[] = [{}, { [`${ROOT}/.project-brain/architecture.json`]: "{}" }, { [`${ROOT}/.project-brain/architecture.json`]: "{nope" }];
    for (const extra of variants) {
      const d = await archGuardDecision(payload, ctx(confident, extra));
      expect(d.block).toBe(false);
      expect(d.reason).toContain('"A"');
    }
  });

  it("allows below the threshold", async () => {
    const d = await archGuardDecision(payload, ctx({ ask: async () => ({ c0: answer(0.7) }) }));
    expect(d.block).toBe(false);
  });

  it("with no token, skips the layer: no constraint read, no ask", async () => {
    let touched = false;
    const d = await archGuardDecision(
      payload,
      ctx({ token: async () => null, constraints: async () => ((touched = true), []), ask: async () => ((touched = true), null) })
    );
    expect(d).toEqual({ block: false });
    expect(touched).toBe(false);
  });

  it("fails open on a null answer and on a throwing ask", async () => {
    expect((await archGuardDecision(payload, ctx({ ask: async () => null }))).block).toBe(false);
    const boom = async () => {
      throw new Error("network");
    };
    expect((await archGuardDecision(payload, ctx({ ask: boom }))).block).toBe(false);
  });

  it("does not ask when no constraint covers the file", async () => {
    let asked = false;
    await archGuardDecision(payload, ctx({ constraints: async () => [], ask: async () => ((asked = true), null) }));
    expect(asked).toBe(false);
  });

  it("does not spend a Jev call once the deterministic layer has blocked", async () => {
    const config = JSON.stringify({
      layers: { domain: "src/domain/**", infra: "src/infra/**" },
      forbid: [{ from: "domain", to: ["infra"] }],
      mode: "block",
    });
    let asked = false;
    const bad = { ...payload, tool_input: { ...payload.tool_input, new_string: 'u = 1;\nimport x from "../infra/db"' } };
    const d = await archGuardDecision(
      bad,
      ctx({ ask: async () => ((asked = true), { c0: answer(0.99) }) }, { [`${ROOT}/.project-brain/architecture.json`]: config })
    );
    expect(d.block).toBe(true);
    expect(d.reason).toContain("Architecture boundary violation");
    expect(asked).toBe(false);
  });

  it("gives Jev only what is left of the hook's budget, and skips it when none is", async () => {
    const timeouts: (number | undefined)[] = [];
    const ask = (async (_t, _s, _q, o) => (timeouts.push(o?.timeoutMs), { c0: answer(0) })) as ArchAsk;
    // First reading is the hook's start; the second is taken just before the Jev call.
    const clockReading = (...readings: number[]) => () => readings.shift() ?? 0;

    await archGuardDecision(payload, ctx({ ask, now: clockReading(0, 100) }));
    await archGuardDecision(payload, ctx({ ask, now: clockReading(0, 1800) }));
    await archGuardDecision(payload, ctx({ ask, now: clockReading(0, 4600) }));
    expect(timeouts).toEqual([3000, 2700]);
  });
});
