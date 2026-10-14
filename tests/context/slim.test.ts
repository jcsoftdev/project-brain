import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryFile } from "../../src/context/claude-md.js";
import { applySlim, revertSlim, measure } from "../../src/context/slim.js";
import { execute, parseSlimArgs } from "../../src/commands/context.js";

const FIXTURE = `<!-- gentle-ai:persona -->
## Rules
Be terse.
<!-- /gentle-ai:persona -->

## Deploy notes

Run the thing.

\`\`\`sh
# not a heading
echo hi
\`\`\`

## Style guide

Tabs.

<!-- CODEGRAPH_START -->
## CodeGraph
use it
<!-- CODEGRAPH_END -->

<!-- project-brain:start -->
## project-brain MCP
x
<!-- project-brain:end -->

<!-- project-brain-model-routing:start -->
routing
<!-- project-brain-model-routing:end -->
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-slim-"));
  await writeFile(join(dir, "CLAUDE.md"), FIXTURE);
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const paths = () => ({ claudeDir: dir });

describe("parseMemoryFile", () => {
  it("classifies project-brain, foreign and user sections", () => {
    const got = parseMemoryFile(FIXTURE).map((s) => [s.id, s.kind]);
    expect(got).toEqual([
      ["block:gentle-ai:persona", "foreign"],
      ["user:deploy-notes", "user"],
      ["user:style-guide", "user"],
      ["block:CODEGRAPH", "foreign"],
      ["block:project-brain", "project-brain"],
      ["block:project-brain-model-routing", "project-brain"],
    ]);
  });

  it("does not split on a # line inside a code fence", () => {
    const deploy = parseMemoryFile(FIXTURE).find((s) => s.id === "user:deploy-notes")!;
    expect(deploy.text).toContain("# not a heading");
  });

  it("treats an unclosed opener as plain text", () => {
    const sections = parseMemoryFile("<!-- a:start -->\n## Mine\nbody\n");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.kind === "user")).toBe(true);
  });
});

describe("apply and revert", () => {
  it("round-trips: moves a user section to a skill, then restores byte for byte", async () => {
    const r = await applySlim(paths(), { ids: ["user:deploy-notes"], now: new Date("2026-01-01T00:00:00Z") });
    expect(r.moved[0]!.skill).toBe("memory-deploy-notes");

    const slim = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(slim).toContain("`memory-deploy-notes` skill");
    expect(slim).not.toContain("Run the thing.");
    const skill = await readFile(join(dir, "skills", "memory-deploy-notes", "SKILL.md"), "utf8");
    expect(skill).toContain("Run the thing.");
    expect(skill).toContain('description: "Reference notes from the \\"Deploy notes\\"');
    expect((await measure(paths())).find((s) => s.id === "block:gentle-ai:persona")).toBeDefined();

    const rev = await revertSlim(paths());
    expect(rev.removedSkills).toHaveLength(1);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(FIXTURE);
    expect(existsSync(join(dir, "skills", "memory-deploy-notes"))).toBe(false);
  });

  it("uses the --description override", async () => {
    await applySlim(paths(), { ids: ["user:style-guide"], description: "when formatting code" });
    const skill = await readFile(join(dir, "skills", "memory-style-guide", "SKILL.md"), "utf8");
    expect(skill).toContain('description: "when formatting code"');
  });

  it("moves several sections at once without shifting line ranges", async () => {
    await applySlim(paths(), { ids: ["user:deploy-notes", "user:style-guide"] });
    const slim = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(slim).toContain("gentle-ai:persona");
    expect(slim).toContain("<!-- CODEGRAPH_END -->");
    expect(slim).not.toContain("Tabs.");
    await revertSlim(paths());
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(FIXTURE);
  });

  it("refuses foreign and project-brain sections and writes nothing", async () => {
    await mkdir(join(dir, "overrides"));
    const r = await applySlim(paths(), {
      ids: ["block:gentle-ai:persona", "block:project-brain", "user:nope"],
    });
    expect(r.moved).toEqual([]);
    expect(r.backup).toBeNull();
    expect(r.refused[0]!.reason).toContain("regenerates");
    expect(r.refused[0]!.reason).toContain(join(dir, "overrides"));
    expect(r.refused[1]!.reason).toContain("project-brain");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(FIXTURE);
    expect(existsSync(join(dir, "skills"))).toBe(false);
  });

  it("keeps edits made after the slim in a safety copy on revert", async () => {
    await applySlim(paths(), { ids: ["user:deploy-notes"] });
    await writeFile(join(dir, "CLAUDE.md"), "edited later\n");
    const rev = await revertSlim(paths());
    expect(await readFile(rev.safetyCopy!, "utf8")).toBe("edited later\n");
  });

  it("reverts two slims in turn, and a third revert is a no-op", async () => {
    await applySlim(paths(), { ids: ["user:deploy-notes"], now: new Date("2026-01-01T00:00:00Z") });
    await applySlim(paths(), { ids: ["user:style-guide"], now: new Date("2026-01-02T00:00:00Z") });
    await writeFile(join(dir, "CLAUDE.md"), `${await readFile(join(dir, "CLAUDE.md"), "utf8")}edited\n`);

    const first = await revertSlim(paths(), new Date("2026-01-03T00:00:00Z"));
    expect(first.removedSkills).toHaveLength(1);
    expect(await readFile(first.safetyCopy!, "utf8")).toContain("edited");
    const second = await revertSlim(paths(), new Date("2026-01-04T00:00:00Z"));
    expect(second.removedSkills).toHaveLength(1);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(FIXTURE);
    expect(existsSync(join(dir, "skills", "memory-deploy-notes"))).toBe(false);
    expect(existsSync(join(dir, "skills", "memory-style-guide"))).toBe(false);
    expect(existsSync(second.safetyCopy!)).toBe(true);
    expect((await revertSlim(paths())).restored).toBeNull();
  });

  it("does not delete a skill the user replaced since", async () => {
    await applySlim(paths(), { ids: ["user:deploy-notes"] });
    await writeFile(join(dir, "skills", "memory-deploy-notes", "SKILL.md"), "mine now\n");
    const rev = await revertSlim(paths());
    expect(rev.removedSkills).toEqual([]);
  });

  it("revert with no backup says so", async () => {
    expect((await revertSlim(paths())).restored).toBeNull();
  });
});

describe("context slim command", () => {
  it("parses --apply ids, --description and --revert", () => {
    expect(parseSlimArgs(["--apply", "a", "b", "--description", "d"])).toEqual({
      apply: ["a", "b"],
      revert: false,
      description: "d",
    });
    expect(parseSlimArgs(["--revert"]).revert).toBe(true);
  });

  it("measure prints an estimate note, kinds and a total", async () => {
    const lines: string[] = [];
    const code = await execute(["slim"], { paths: paths(), log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("estimates");
    expect(out).toContain("yours");
    expect(out).toContain("other tool");
    expect(out).toContain("project-brain ");
    expect(out).toContain("total");
  });
});
