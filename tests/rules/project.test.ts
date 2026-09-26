import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * T-6.2: Project rules generator
 * Tests writeProjectRules — generates CLAUDE.md with project-brain section
 * from the project template, substituting projectId and stack.
 */
describe("writeProjectRules", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-project-rules-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports writeProjectRules function", async () => {
    const mod = await import("../../src/rules/project.js");
    expect(typeof mod.writeProjectRules).toBe("function");
  });

  it("creates CLAUDE.md in the project root", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "test-project-123",
      stack: { languages: ["TypeScript"], frameworks: ["Hono"], packageManager: "bun", manifest: "package.json" },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });

  it("substitutes {{projectId}} with the given projectId", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "my-unique-project",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain("my-unique-project");
    expect(content).not.toContain("{{projectId}}");
  });

  it("substitutes {{stack}} with a human-readable stack summary", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "any-id",
      stack: { languages: ["TypeScript"], frameworks: ["React"], packageManager: "bun", manifest: "package.json" },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).not.toContain("{{stack}}");
    // Should include language info
    expect(content).toContain("TypeScript");
  });

  it("wraps content in project-brain section markers (idempotent)", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "idempotent-test",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });
    // Second call should not duplicate
    await writeProjectRules(tempDir, {
      projectId: "idempotent-test",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    const startCount = content.split("<!-- project-brain:start -->").length - 1;
    expect(startCount).toBe(1);
  });

  it("preserves existing CLAUDE.md content outside markers", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    // Pre-write some user content
    await Bun.write(join(tempDir, "CLAUDE.md"), "# My project rules\n\nDo not delete me.\n");

    await writeProjectRules(tempDir, {
      projectId: "preserve-test",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain("# My project rules");
    expect(content).toContain("Do not delete me.");
    expect(content).toContain("<!-- project-brain:start -->");
  });

  it("contains project-brain MCP tool references", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "tool-check",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain("search_context");
    expect(content).toContain("project-brain");
  });

  /**
   * Was "generated rules advertise ALL tools incl. the structural layer (no
   * stale list)" — it asserted the project CLAUDE.md re-embedded the entire
   * TOOL_CATALOG. That guard now lives on SERVER_INSTRUCTIONS itself
   * (tests/constants.test.ts), which is the one copy Claude Code is proven to
   * receive live on every MCP connection. Duplicating it a second time here,
   * in a file baked into the repo, meant re-running `init` was the only way
   * to pick up a newly added tool — worse than the single source of truth it
   * was meant to guarantee. This project's CLAUDE.md now points at that live
   * copy instead.
   */
  it("points at the MCP server's own instructions instead of re-embedding the tool catalog", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "all-tools",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const content = await readFile(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("search_context");
    expect(content).toContain("project-brain");
    // The rest of the catalog is no longer duplicated here.
    for (const t of [
      "find_callers",
      "find_callees",
      "list_modules",
      "get_module",
      "add_knowledge",
      "delete_knowledge",
      "check_health",
    ]) {
      expect(content).not.toContain(t);
    }
  });

  /**
   * Scenario 2.6 — CLAUDE.md contains module instructions [unit]
   */
  it("Scenario 2.6: includes ## Module Documentation section when modules provided", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "mod-doc-test",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
      modules: ["commands", "store"],
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain("## Module Documentation");
    expect(content).toContain("- commands");
    expect(content).toContain("- store");
    expect(content).toContain("add_knowledge");
    expect(content).toContain("docs/modules/");
  });

  /**
   * Scenario 2.7 — Zero modules detected [unit]
   * When modules: [] → CLAUDE.md does NOT contain "## Module Documentation"
   */
  it("Scenario 2.7: omits ## Module Documentation section when modules is empty", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "no-mod-test",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
      modules: [],
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).not.toContain("## Module Documentation");
  });

  it("Scenario 2.7: omits ## Module Documentation when modules field not provided", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "no-mod-test-2",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).not.toContain("## Module Documentation");
  });
});

/**
 * `isProjectRulesCurrent` is the read-only half of the same self-healing
 * story `writeProjectRules` already provides: `init` rewrites the section
 * unconditionally on every run, but nothing could previously tell a caller
 * (e.g. `health`) whether the block on disk still matched the template
 * before that next run happens.
 */
describe("isProjectRulesCurrent", () => {
  let tempDir: string;
  const info = {
    projectId: "stale-check",
    stack: { languages: ["TypeScript"], frameworks: [], packageManager: "bun", manifest: "package.json" },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-project-rules-stale-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("is false when CLAUDE.md does not exist yet", async () => {
    const { isProjectRulesCurrent } = await import("../../src/rules/project.js");
    expect(await isProjectRulesCurrent(tempDir, info)).toBe(false);
  });

  it("is true immediately after writeProjectRules", async () => {
    const { writeProjectRules, isProjectRulesCurrent } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, info);
    expect(await isProjectRulesCurrent(tempDir, info)).toBe(true);
  });

  it("is false when the written block came from an old template", async () => {
    const { writeSection } = await import("../../src/rules/section-marker.js");
    const { isProjectRulesCurrent } = await import("../../src/rules/project.js");

    await writeSection(join(tempDir, "CLAUDE.md"), "## project-brain MCP\n\nan old full tool catalog\n");
    expect(await isProjectRulesCurrent(tempDir, info)).toBe(false);
  });

  it("is false when info changed (e.g. a newly detected module) even though the block was once current", async () => {
    const { writeProjectRules, isProjectRulesCurrent } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, info);
    expect(await isProjectRulesCurrent(tempDir, { ...info, modules: ["newly-added"] })).toBe(false);
  });

  it("preserves human-authored content outside the markers when the stale block is rewritten", async () => {
    const { writeProjectRules, isProjectRulesCurrent } = await import("../../src/rules/project.js");
    await Bun.write(join(tempDir, "CLAUDE.md"), "# Team notes\n\nKeep this.\n");
    const { writeSection } = await import("../../src/rules/section-marker.js");
    await writeSection(join(tempDir, "CLAUDE.md"), "## project-brain MCP\n\nold\n");
    expect(await isProjectRulesCurrent(tempDir, info)).toBe(false);

    await writeProjectRules(tempDir, info);
    const content = await readFile(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Team notes");
    expect(content).toContain("Keep this.");
    expect(await isProjectRulesCurrent(tempDir, info)).toBe(true);
  });
});

/**
 * The OKF block is conditional on the bundle EXISTING.
 *
 * A project with no `okf/` must not be told to maintain one — the instruction
 * would be dead weight in every CLAUDE.md that project-brain touches. And the
 * ordering matters: `project-brain init` runs before any bundle exists, so
 * `okf init` has to re-render this section afterwards or the instruction never
 * appears at all.
 */
describe("writeProjectRules — conditional OKF block", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-okf-rules-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const stack = { languages: ["TypeScript"], frameworks: [], packageManager: "bun", manifest: "package.json" };

  async function claudeMd(): Promise<string> {
    return readFile(join(tempDir, "CLAUDE.md"), "utf8");
  }

  it("omits the OKF section entirely when no bundle exists", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, { projectId: "p", stack });

    const content = await claudeMd();
    expect(content).not.toContain("Knowledge bundle");
    expect(content).not.toContain("okf audit");
  });

  it("omits it when hasOkfBundle is explicitly false", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, { projectId: "p", stack, hasOkfBundle: false });
    expect(await claudeMd()).not.toContain("Knowledge bundle");
  });

  it("includes the block, the commands, and the end-of-task checkpoint when a bundle exists", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, { projectId: "p", stack, hasOkfBundle: true });

    const content = await claudeMd();
    expect(content).toContain("Knowledge bundle");
    expect(content).toContain("okf audit");
    expect(content).toContain("brain-okf");
  });

  /** "Nothing to record" must read as a valid outcome, or this becomes a concept mill. */
  it("states that most tasks produce no concept", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, { projectId: "p", stack, hasOkfBundle: true });
    expect(await claudeMd()).toMatch(/most tasks|Most tasks/);
  });

  it("re-rendering without the bundle removes the block again", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");
    await writeProjectRules(tempDir, { projectId: "p", stack, hasOkfBundle: true });
    expect(await claudeMd()).toContain("Knowledge bundle");

    await writeProjectRules(tempDir, { projectId: "p", stack, hasOkfBundle: false });
    expect(await claudeMd()).not.toContain("Knowledge bundle");
  });
});
