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

  it("generated rules advertise ALL tools incl. the structural layer (no stale list)", async () => {
    const { writeProjectRules } = await import("../../src/rules/project.js");

    await writeProjectRules(tempDir, {
      projectId: "all-tools",
      stack: { languages: [], frameworks: [], packageManager: null, manifest: null },
    });

    const content = await readFile(join(tempDir, "CLAUDE.md"), "utf-8");
    for (const t of [
      "search_context",
      "expand_context",
      "find_symbol",
      "find_callers",
      "find_callees",
      "impact",
      "list_modules",
      "get_module",
      "add_knowledge",
      "delete_knowledge",
      "check_health",
    ]) {
      expect(content).toContain(t);
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
