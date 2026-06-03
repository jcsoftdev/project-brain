import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * T-09: package.json metadata, scripts, optionalDependencies
 * T-10: README.md existence and content
 */

describe("package.json distribution metadata (T-09)", () => {
  async function loadPkg() {
    const raw = await Bun.file(join(ROOT, "package.json")).text();
    return JSON.parse(raw);
  }

  it("scripts.build equals the compile command (DIST-2)", async () => {
    const pkg = await loadPkg();
    expect(pkg.scripts?.build).toContain("bun build ./src/cli.ts --compile");
  });

  it("optionalDependencies includes platform packages (DIST-3)", async () => {
    const pkg = await loadPkg();
    const optDeps = pkg.optionalDependencies ?? {};
    expect(optDeps).toHaveProperty("project-brain-darwin-arm64");
    expect(optDeps).toHaveProperty("project-brain-linux-x64");
    expect(optDeps).toHaveProperty("project-brain-linux-arm64");
    expect(optDeps).toHaveProperty("project-brain-windows-x64");
    expect(optDeps).toHaveProperty("project-brain-windows-arm64");
  });

  it("description is a non-empty string (DIST-5)", async () => {
    const pkg = await loadPkg();
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
  });

  it("license === MIT (DIST-5)", async () => {
    const pkg = await loadPkg();
    expect(pkg.license).toBe("MIT");
  });

  it("author === jcsoftdev (DIST-5)", async () => {
    const pkg = await loadPkg();
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    expect(author).toBe("jcsoftdev");
  });

  it("files includes bin, templates, README.md (DIST-5)", async () => {
    const pkg = await loadPkg();
    const files: string[] = pkg.files ?? [];
    expect(files).toContain("bin");
    expect(files).toContain("templates");
    expect(files).toContain("README.md");
  });

  it("keywords includes mcp, rag, lancedb, ollama (DIST-5)", async () => {
    const pkg = await loadPkg();
    const kw: string[] = pkg.keywords ?? [];
    expect(kw).toContain("mcp");
    expect(kw).toContain("rag");
    expect(kw).toContain("lancedb");
    expect(kw).toContain("ollama");
  });

  it("zod dependency matches ^4.x (DIST-6 gate: compatible path)", async () => {
    const pkg = await loadPkg();
    expect(pkg.dependencies?.zod).toMatch(/^\^4\./);
  });
});

/**
 * Scenario 3.1 — README exists and has required sections [unit]
 */
describe("README.md (T-10)", () => {
  async function loadReadme() {
    return Bun.file(join(ROOT, "README.md")).text();
  }

  it("file exists at repo root", async () => {
    const content = await loadReadme();
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains bun install -g project-brain", async () => {
    const content = await loadReadme();
    expect(content).toContain("bun install -g project-brain");
  });

  it("contains bun build ./src/cli.ts --compile", async () => {
    const content = await loadReadme();
    expect(content).toContain("bun build ./src/cli.ts --compile");
  });

  it("contains setup command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("setup");
  });

  it("contains init command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("init");
  });

  it("contains sync command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("sync");
  });

  it("contains reindex command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("reindex");
  });

  it("contains health command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("health");
  });

  it("contains serve --http command reference", async () => {
    const content = await loadReadme();
    expect(content).toContain("serve --http");
  });

  it("contains Bun prerequisite", async () => {
    const content = await loadReadme();
    expect(content).toContain("Bun");
  });

  it("contains Ollama prerequisite", async () => {
    const content = await loadReadme();
    expect(content).toContain("Ollama");
  });
});
