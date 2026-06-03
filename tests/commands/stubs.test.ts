import { describe, it, expect } from "bun:test";
import { join } from "node:path";

/**
 * Smoke tests: verify every command module exports an `execute` function.
 * Commands that were stubs have been implemented — this file only checks
 * the public execute export contract. Command-specific behavior is tested
 * in their own dedicated test files.
 */
const commands = ["init", "sync", "reindex", "health", "setup"] as const;

describe("Command exports", () => {
  for (const name of commands) {
    it(`${name}: exports execute function`, async () => {
      const mod = await import(`../../src/commands/${name}.js`);
      expect(typeof mod.execute).toBe("function");
    });
  }
});

/**
 * Scenario 2.1 — Template file content [unit]
 * templates/module-doc.md must contain {{name}} placeholder and all required headings.
 */
describe("Scenario 2.1: templates/module-doc.md", () => {
  it("exists and contains {{name}} placeholder", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("{{name}}");
  });

  it("contains ## Purpose heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Purpose");
  });

  it("contains ## Key Files heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Key Files");
  });

  it("contains ## Dependencies heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Dependencies");
  });

  it("contains ## Data Flow heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Data Flow");
  });

  it("contains ## Gotchas heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Gotchas");
  });

  it("contains ## Last Updated heading", async () => {
    const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
    const content = await Bun.file(templatePath).text();
    expect(content).toContain("## Last Updated");
  });
});
