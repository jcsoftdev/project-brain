import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStyleGuardContext, styleGuardInjection, type StyleGuardContext } from "../../src/hooks/style-guard.js";
import { MAIN_AGENT, parseEditTarget } from "../../src/style-guard/payload.js";
import { classifyPath } from "../../src/style-guard/rules.js";
import { markSeen, parseSeen, unseenSkills } from "../../src/style-guard/seen.js";
import { skillBody } from "../../src/style-guard/skill-text.js";

describe("classifyPath", () => {
  const cases: Array<[string, ReturnType<typeof classifyPath>]> = [
    ["/p/src/a.ts", { kind: "apply", skills: ["brain-style"] }],
    ["/p/src/A.TSX", { kind: "apply", skills: ["brain-style"] }],
    ["/p/main.py", { kind: "apply", skills: ["brain-style"] }],
    ["/p/README.md", { kind: "skip" }],
    ["/p/package.json", { kind: "skip" }],
    ["/p/bun.lock", { kind: "skip" }],
    ["/p/Dockerfile", { kind: "unknown" }],
    ["/p/theme.scss", { kind: "unknown" }],
  ];
  it.each(cases)("%s", (path, expected) => expect(classifyPath(path)).toEqual(expected));
});

describe("parseEditTarget", () => {
  const base = { tool_name: "Edit", session_id: "s1", tool_input: { file_path: "/p/a.ts" } };
  it("keys the main session as main and a sub-agent by its id", () => {
    expect(parseEditTarget(base)).toEqual({ filePath: "/p/a.ts", sessionId: "s1", agentId: MAIN_AGENT });
    expect(parseEditTarget({ ...base, agent_id: "ag-7" })?.agentId).toBe("ag-7");
  });
  it.each([
    null,
    "x",
    { ...base, tool_name: "Bash" },
    { ...base, session_id: "" },
    { ...base, tool_input: {} },
    { ...base, tool_input: { file_path: 3 } },
  ])("rejects %p", (payload) => expect(parseEditTarget(payload)).toBeNull());
});

describe("seen", () => {
  it("is per agent and per skill", () => {
    const seen = new Set(markSeen(new Set(), "main", ["brain-style"]));
    expect(unseenSkills(seen, "main", ["brain-style"])).toEqual([]);
    expect(unseenSkills(seen, "ag-1", ["brain-style"])).toEqual(["brain-style"]);
  });
  it("reads garbage as empty", () => {
    expect(parseSeen(null).size).toBe(0);
    expect(parseSeen("{").size).toBe(0);
    expect(parseSeen('{"a":1}').size).toBe(0);
    expect([...parseSeen('["main:brain-style",3]')]).toEqual(["main:brain-style"]);
  });
});

describe("skillBody", () => {
  it("drops frontmatter and html comments", () => {
    const md = "---\nname: x\n---\n\n<!--\n  marker\n-->\n\n## Rules\nbody\n";
    expect(skillBody(md)).toBe("## Rules\nbody");
  });
});

function memoryContext(over: Partial<StyleGuardContext> = {}) {
  const store = new Map<string, string[]>();
  const ctx: StyleGuardContext = {
    readSkill: async () => "---\nname: brain-style\n---\nRULES",
    readSeen: async (id) => new Set(store.get(id) ?? []),
    writeSeen: async (id, seen) => void store.set(id, seen),
    token: async () => null,
    ...over,
  };
  return ctx;
}

const edit = (file: string, extra: object = {}) => ({
  tool_name: "Write",
  session_id: "s1",
  tool_input: { file_path: file },
  ...extra,
});

describe("styleGuardInjection", () => {
  it("injects once per session and agent", async () => {
    const ctx = memoryContext();
    expect(await styleGuardInjection(edit("/p/a.ts"), ctx)).toContain("RULES");
    expect(await styleGuardInjection(edit("/p/b.ts"), ctx)).toBeNull();
    expect(await styleGuardInjection(edit("/p/b.ts", { agent_id: "ag-1" }), ctx)).toContain("RULES");
    expect(await styleGuardInjection({ ...edit("/p/b.ts"), session_id: "s2" }, ctx)).toContain("RULES");
  });

  it("stays silent for non-code files without asking Jev", async () => {
    let asked = false;
    const ctx = memoryContext({ token: async () => "t", ask: async () => ((asked = true), null) });
    expect(await styleGuardInjection(edit("/p/README.md"), ctx)).toBeNull();
    expect(asked).toBe(false);
  });

  it("stays silent when the skill is not installed", async () => {
    expect(await styleGuardInjection(edit("/p/a.ts"), memoryContext({ readSkill: async () => null }))).toBeNull();
  });

  it("asks Jev only for unclassified files and only with a token", async () => {
    const answer = (p: number) => ({ "brain-style": { type: "choice" as const, choice: "yes", confidence: p, probabilities: { yes: p, no: 1 - p } } });
    const noToken = memoryContext({ ask: async () => answer(0.99) });
    expect(await styleGuardInjection(edit("/p/Dockerfile"), noToken)).toBeNull();

    const sure = memoryContext({ token: async () => "t", ask: async () => answer(0.95) });
    expect(await styleGuardInjection(edit("/p/Dockerfile"), sure)).toContain("RULES");

    const unsure = memoryContext({ token: async () => "t", ask: async () => answer(0.3) });
    expect(await styleGuardInjection(edit("/p/Dockerfile"), unsure)).toBeNull();
  });

  it("fails open when Jev or storage throw", async () => {
    const boom = async (): Promise<never> => {
      throw new Error("down");
    };
    expect(await styleGuardInjection(edit("/p/Dockerfile"), memoryContext({ token: async () => "t", ask: boom }))).toBeNull();
    expect(await styleGuardInjection(edit("/p/a.ts"), memoryContext({ readSeen: boom }))).toBeNull();
    expect(await styleGuardInjection(edit("/p/a.ts"), memoryContext({ writeSeen: boom }))).toContain("RULES");
  });
});

describe("style-guard hook entry", () => {
  it("reads the installed skill and the state file from disk", async () => {
    const home = await mkdtemp(join(tmpdir(), "pb-style-home-"));
    const data = await mkdtemp(join(tmpdir(), "pb-style-data-"));
    await mkdir(join(home, ".claude", "skills", "brain-style"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "brain-style", "SKILL.md"), "---\nname: brain-style\n---\nDISK RULES\n");
    const ctx = readStyleGuardContext(data, home);

    expect(await styleGuardInjection(edit("/p/a.ts"), ctx)).toContain("DISK RULES");
    expect(await styleGuardInjection(edit("/p/a.ts"), ctx)).toBeNull();
    expect(await styleGuardInjection(edit("/p/a.ts"), readStyleGuardContext(data, join(home, "none")))).toBeNull();
  });
});

describe("project-brain style-guard process", () => {
  it("prints additionalContext once for fixture stdin and exits 0", async () => {
    const home = await mkdtemp(join(tmpdir(), "pb-style-proc-"));
    await mkdir(join(home, ".claude", "skills", "brain-style"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "brain-style", "SKILL.md"), "---\nname: brain-style\n---\nPROC RULES\n");
    const run = async () => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/cli.ts"), "style-guard"], {
        env: { ...process.env, HOME: home },
        stdin: new Blob([JSON.stringify(edit("/p/a.ts"))]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out };
    };

    const first = await run();
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      additionalContext: expect.stringContaining("PROC RULES"),
    });
    expect((await run()).out).toBe("");
  });
});
