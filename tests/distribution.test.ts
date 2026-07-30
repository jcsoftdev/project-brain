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
    // worker.ts MUST be a second entrypoint so `--compile` bundles the
    // worker-pool parser's full graph + embedded WASM into the binary
    // (otherwise the pool path silently yields zero symbols). See
    // src/parser/pool.ts.
    expect(pkg.scripts?.build).toContain("bun build ./src/cli.ts ./src/parser/worker.ts --compile");
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

  /**
   * The build command MUST pass worker.ts as a second entrypoint. Without it
   * `--compile` does not bundle the parser worker pool's module graph or its
   * embedded WASM, and the resulting binary silently extracts zero symbols —
   * every structural tool returns empty with no error. The README documented
   * the single-entrypoint form for a while, which is a recipe for a broken build.
   */
  it("documents the build with BOTH entrypoints, not just cli.ts", async () => {
    const content = await loadReadme();
    expect(content).toContain("bun build ./src/cli.ts ./src/parser/worker.ts --compile");
    expect(content).not.toMatch(/bun build \.\/src\/cli\.ts --compile/);
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

  /**
   * Every install channel that exists must be documented, and the no-package-
   * manager one must appear in the Quick Start — not only buried in Install.
   * The Prerequisites section states outright that Bun and Node are not needed
   * to run project-brain; a Quick Start whose only step 1 is `bun install`
   * contradicts that on the first screen anyone reads.
   */
  it("documents every install channel, including the one needing no package manager", async () => {
    const content = await loadReadme();
    expect(content).toContain("scripts/install.sh | sh");
    expect(content).toContain("bun install -g project-brain");
    expect(content).toContain("brew install jcsoftdev/tap/project-brain");
    expect(content).toContain("scoop install project-brain");
  });

  it("offers the package-manager-free install in the Quick Start, not only in Install", async () => {
    const content = await loadReadme();
    const quickStart = content.slice(
      content.indexOf("## Quick Start"),
      content.indexOf("## Prerequisites")
    );
    expect(quickStart.length).toBeGreaterThan(0);
    expect(quickStart).toContain("scripts/install.sh | sh");
  });

  it("documents the install-dir and version overrides the script actually reads", async () => {
    const content = await loadReadme();
    const script = await Bun.file(join(ROOT, "scripts/install.sh")).text();
    for (const envVar of ["BRAIN_INSTALL_DIR", "BRAIN_VERSION"]) {
      expect(script, `${envVar} missing from the script`).toContain(envVar);
      expect(content, `${envVar} undocumented`).toContain(envVar);
    }
  });

  /**
   * setup writes brain-audit into the user's global skills directory, so the
   * README has to say so and has to say how to decline. Without this assertion
   * the section can be deleted and nothing complains — exactly the "no
   * enforcement keeping docs honest" gap the skill's own documentation module
   * reports.
   */
  it("documents the brain-audit skill and its opt-out", async () => {
    const content = await loadReadme();
    expect(content).toContain("brain-audit");
    expect(content).toContain("--no-brain-audit");
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
