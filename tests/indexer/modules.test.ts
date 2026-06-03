import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Tests for detectModules and writeModuleStubs (T-02, T-03)
 */
describe("detectModules", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-modules-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Scenario 2.2 — detectModules returns only qualifying directories [unit]
   * Given  a temp root with:
   *          src/index.ts, tests/foo.test.ts, node_modules/lodash/index.js,
   *          .git/config, docs/README.md
   * Then   result === ["docs", "src", "tests"]
   */
  it("Scenario 2.2: returns qualifying dirs sorted, excludes node_modules and .git", async () => {
    // Create files in qualifying dirs
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "index.ts"), "export {};");

    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(join(tempDir, "tests", "foo.test.ts"), "// test");

    // docs with .md file (in recognized extension list)
    await mkdir(join(tempDir, "docs"), { recursive: true });
    await writeFile(join(tempDir, "docs", "README.md"), "# Docs");

    // node_modules — must be excluded
    await mkdir(join(tempDir, "node_modules", "lodash"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "lodash", "index.js"), "module.exports={};");

    // .git — must be excluded (dotdir)
    await mkdir(join(tempDir, ".git"), { recursive: true });
    await writeFile(join(tempDir, ".git", "config"), "[core]");

    const { detectModules } = await import("../../src/indexer/modules.js");
    const result = await detectModules(tempDir);

    expect(result).toEqual(["docs", "src", "tests"]);
  });

  /**
   * Scenario 2.3 — No source files means no module [unit]
   * Given  a temp root with an empty directory
   * Then   result === []
   */
  it("Scenario 2.3: empty directory returns []", async () => {
    await mkdir(join(tempDir, "empty-dir"), { recursive: true });

    const { detectModules } = await import("../../src/indexer/modules.js");
    const result = await detectModules(tempDir);

    expect(result).toEqual([]);
  });

  it("excludes all WATCHER_ALWAYS_IGNORE dirs", async () => {
    // Only create an ignored dir with a source file
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "dist", "bundle.js"), "// bundle");

    await mkdir(join(tempDir, "build"), { recursive: true });
    await writeFile(join(tempDir, "build", "output.js"), "// output");

    const { detectModules } = await import("../../src/indexer/modules.js");
    const result = await detectModules(tempDir);

    expect(result).toEqual([]);
  });

  it("includes a dir with source files at any depth", async () => {
    await mkdir(join(tempDir, "packages", "core", "src"), { recursive: true });
    await writeFile(join(tempDir, "packages", "core", "src", "index.ts"), "export {};");

    const { detectModules } = await import("../../src/indexer/modules.js");
    const result = await detectModules(tempDir);

    expect(result).toEqual(["packages"]);
  });
});

describe("writeModuleStubs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-stubs-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Scenario 2.4 — Stubs created for each module [unit]
   */
  it("Scenario 2.4: creates stub for each module with correct heading", async () => {
    const { writeModuleStubs } = await import("../../src/indexer/modules.js");
    const projectId = "test-project-123";

    await writeModuleStubs(tempDir, ["commands", "store", "tools"], { projectId });

    const fs = await import("node:fs/promises");
    const commandsContent = await fs.readFile(
      join(tempDir, "docs", "modules", "commands.md"),
      "utf-8"
    );
    const storeContent = await fs.readFile(
      join(tempDir, "docs", "modules", "store.md"),
      "utf-8"
    );
    const toolsContent = await fs.readFile(
      join(tempDir, "docs", "modules", "tools.md"),
      "utf-8"
    );

    expect(commandsContent).toContain("# Module: commands");
    expect(storeContent).toContain("# Module: store");
    expect(toolsContent).toContain("# Module: tools");
  });

  it("Scenario 2.4: returns list of paths actually created", async () => {
    const { writeModuleStubs } = await import("../../src/indexer/modules.js");
    const projectId = "test-project-123";

    const created = await writeModuleStubs(tempDir, ["commands", "store"], { projectId });

    expect(created.length).toBe(2);
    expect(created.some((p) => p.endsWith("commands.md"))).toBe(true);
    expect(created.some((p) => p.endsWith("store.md"))).toBe(true);
  });

  /**
   * Scenario 2.5 — Existing stub is not overwritten [unit]
   */
  it("Scenario 2.5: does not overwrite an existing stub file", async () => {
    const { writeModuleStubs } = await import("../../src/indexer/modules.js");
    const projectId = "test-project-123";
    const fs = await import("node:fs/promises");

    // Pre-create the store stub with "FILLED" content
    await mkdir(join(tempDir, "docs", "modules"), { recursive: true });
    await fs.writeFile(join(tempDir, "docs", "modules", "store.md"), "FILLED");

    // Call writeModuleStubs — should skip existing
    const created = await writeModuleStubs(tempDir, ["commands", "store", "tools"], { projectId });

    // store.md was NOT recreated
    const storeContent = await fs.readFile(
      join(tempDir, "docs", "modules", "store.md"),
      "utf-8"
    );
    expect(storeContent).toBe("FILLED");

    // created list only has commands and tools (not store)
    expect(created.some((p) => p.endsWith("store.md"))).toBe(false);
    expect(created.some((p) => p.endsWith("commands.md"))).toBe(true);
    expect(created.some((p) => p.endsWith("tools.md"))).toBe(true);
  });

  it("returns empty array when modules list is empty", async () => {
    const { writeModuleStubs } = await import("../../src/indexer/modules.js");
    const created = await writeModuleStubs(tempDir, [], { projectId: "x" });
    expect(created).toEqual([]);
  });
});
