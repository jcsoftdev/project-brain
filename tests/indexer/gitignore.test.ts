import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { shouldIgnore, loadPatterns } from "../../src/indexer/gitignore.js";

describe("gitignore filter", () => {
  describe("shouldIgnore", () => {
    it("always ignores .git/", () => {
      expect(shouldIgnore(".git/config", [])).toBe(true);
      expect(shouldIgnore(".git/HEAD", [])).toBe(true);
    });

    it("always ignores node_modules/", () => {
      expect(shouldIgnore("node_modules/foo.js", [])).toBe(true);
      expect(shouldIgnore("src/node_modules/bar.ts", [])).toBe(true);
    });

    it("always ignores dist/", () => {
      expect(shouldIgnore("dist/bundle.js", [])).toBe(true);
    });

    it("always ignores build/", () => {
      expect(shouldIgnore("build/output.js", [])).toBe(true);
    });

    it("always ignores .next/", () => {
      expect(shouldIgnore(".next/server/app.js", [])).toBe(true);
    });

    it("always ignores target/", () => {
      expect(shouldIgnore("target/debug/main", [])).toBe(true);
    });

    it("always ignores __pycache__/", () => {
      expect(shouldIgnore("__pycache__/mod.pyc", [])).toBe(true);
    });

    it("always ignores .claude/ (agent worktrees must not pollute the index)", () => {
      expect(shouldIgnore(".claude/worktrees/agent-x/src/foo.ts", [])).toBe(true);
      expect(shouldIgnore(".claude/settings.json", [])).toBe(true);
      expect(shouldIgnore("src/foo.ts", [])).toBe(false);
    });

    it("matches ALWAYS_IGNORE entries as path segments, not substrings", () => {
      // Directory name merely CONTAINS the ignored segment as a substring —
      // must NOT be treated as the real ignored directory.
      expect(shouldIgnore("src/foo.claude/bar.ts", [])).toBe(false);
      expect(shouldIgnore("my.claude/x.ts", [])).toBe(false);
      // "dist" substring inside an unrelated filename/dirname.
      expect(shouldIgnore("src/redistribute.ts", [])).toBe(false);
      expect(shouldIgnore("redistribution/index.ts", [])).toBe(false);
      // "target" substring inside an unrelated dirname.
      expect(shouldIgnore("src/retargeting.ts", [])).toBe(false);
      // "build" substring inside an unrelated dirname.
      expect(shouldIgnore("src/rebuild-helpers/x.ts", [])).toBe(false);
      // "node_modules" substring inside an unrelated dirname.
      expect(shouldIgnore("src/node_modules_polyfill/x.ts", [])).toBe(false);
    });

    it("regression: every ALWAYS_IGNORE entry still matches a genuine path under it", () => {
      expect(shouldIgnore(".git/config", [])).toBe(true);
      expect(shouldIgnore("node_modules/x", [])).toBe(true);
      expect(shouldIgnore("dist/bundle.js", [])).toBe(true);
      expect(shouldIgnore("build/output.js", [])).toBe(true);
      expect(shouldIgnore(".next/server/app.js", [])).toBe(true);
      expect(shouldIgnore("target/debug/main", [])).toBe(true);
      expect(shouldIgnore("__pycache__/mod.pyc", [])).toBe(true);
      expect(shouldIgnore(".project-brain/index.db", [])).toBe(true);
      expect(shouldIgnore(".claude/worktrees/agent-x/src/foo.ts", [])).toBe(true);
      // Nested (not just root-level) genuine occurrences must still match.
      expect(shouldIgnore("packages/app/node_modules/x.js", [])).toBe(true);
      expect(shouldIgnore("packages/app/dist/bundle.js", [])).toBe(true);
    });

    it("does not ignore normal files with no patterns", () => {
      expect(shouldIgnore("src/main.ts", [])).toBe(false);
      expect(shouldIgnore("README.md", [])).toBe(false);
    });

    it("matches custom patterns", () => {
      const patterns = ["*.log", "tmp/"];
      expect(shouldIgnore("error.log", patterns)).toBe(true);
      expect(shouldIgnore("tmp/cache.txt", patterns)).toBe(true);
      expect(shouldIgnore("src/main.ts", patterns)).toBe(false);
    });

    it("handles negation patterns (basic)", () => {
      const patterns = ["*.log", "!important.log"];
      expect(shouldIgnore("debug.log", patterns)).toBe(true);
      expect(shouldIgnore("important.log", patterns)).toBe(false);
    });

    it("does not let a single '*' cross a '/' boundary", () => {
      const patterns = ["logs/*.txt"];
      expect(shouldIgnore("logs/report.txt", patterns)).toBe(true);
      expect(shouldIgnore("logs/keep/report.txt", patterns)).toBe(false);
    });

    it("matches globstar '**' across directories", () => {
      const patterns = ["**/*.log"];
      expect(shouldIgnore("a/b/c.log", patterns)).toBe(true);
    });

    it("matches trailing globstar 'dir/**' across nested directories", () => {
      const patterns = ["build/**"];
      expect(shouldIgnore("build/x/y", patterns)).toBe(true);
      expect(shouldIgnore("build/x", patterns)).toBe(true);
    });

    it("still matches a bare '*.md' pattern against the basename", () => {
      const patterns = ["*.md"];
      expect(shouldIgnore("README.md", patterns)).toBe(true);
      expect(shouldIgnore("docs/CHANGELOG.md", patterns)).toBe(true);
    });

    it("matches '?' as a single non-slash character", () => {
      const patterns = ["file?.txt"];
      expect(shouldIgnore("file1.txt", patterns)).toBe(true);
      expect(shouldIgnore("file12.txt", patterns)).toBe(false);
      expect(shouldIgnore("file/.txt", patterns)).toBe(false);
    });
  });

  describe("loadPatterns", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "gitignore-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("parses .gitignore from root", async () => {
      await Bun.write(
        join(tempDir, ".gitignore"),
        "*.log\n# comment\n\ntmp/\n"
      );

      const patterns = await loadPatterns(tempDir);
      expect(patterns).toContain("*.log");
      expect(patterns).toContain("tmp/");
      expect(patterns).not.toContain("# comment");
      expect(patterns).not.toContain("");
    });

    it("returns empty array if no .gitignore", async () => {
      const patterns = await loadPatterns(tempDir);
      expect(patterns).toEqual([]);
    });

    it("orders parent patterns before child patterns so deeper negation wins deterministically", async () => {
      const { mkdir } = await import("node:fs/promises");
      // Sibling directories with varying .gitignore sizes to perturb
      // filesystem I/O completion order for the Promise.all fan-out.
      for (const name of ["subA", "subB", "subC", "subD", "subE"]) {
        await mkdir(join(tempDir, name));
      }
      await Bun.write(join(tempDir, ".gitignore"), "*.log\n");
      // Large filler content so this sibling's read is slower than others.
      await Bun.write(
        join(tempDir, "subA", ".gitignore"),
        "# filler\n".repeat(5000) + "!keep.log\n"
      );
      await Bun.write(join(tempDir, "subB", ".gitignore"), "*.tmp\n");
      await Bun.write(join(tempDir, "subC", ".gitignore"), "*.bak\n");
      await Bun.write(join(tempDir, "subD", ".gitignore"), "*.old\n");
      await Bun.write(join(tempDir, "subE", ".gitignore"), "*.cache\n");

      const patterns = await loadPatterns(tempDir);
      expect(shouldIgnore("subA/keep.log", patterns)).toBe(false);
      expect(shouldIgnore("subA/other.log", patterns)).toBe(true);

      // Parent's own pattern must precede any child directory's pattern.
      const rootIdx = patterns.indexOf("*.log");
      const childIdx = patterns.indexOf("!subA/keep.log");
      expect(rootIdx).toBeGreaterThanOrEqual(0);
      expect(childIdx).toBeGreaterThanOrEqual(0);
      expect(rootIdx).toBeLessThan(childIdx);
    });

    it("produces identical pattern order across repeated concurrent runs", async () => {
      const { mkdir } = await import("node:fs/promises");
      for (const name of ["subA", "subB", "subC", "subD", "subE"]) {
        await mkdir(join(tempDir, name));
      }
      await Bun.write(join(tempDir, ".gitignore"), "*.log\n");
      await Bun.write(
        join(tempDir, "subA", ".gitignore"),
        "# filler\n".repeat(5000) + "!keep.log\n"
      );
      await Bun.write(join(tempDir, "subB", ".gitignore"), "*.tmp\n");
      await Bun.write(join(tempDir, "subC", ".gitignore"), "*.bak\n");
      await Bun.write(join(tempDir, "subD", ".gitignore"), "*.old\n");
      await Bun.write(join(tempDir, "subE", ".gitignore"), "*.cache\n");

      const [runA, runB] = await Promise.all([
        loadPatterns(tempDir),
        loadPatterns(tempDir),
      ]);
      expect(runA).toEqual(runB);
    });
  });
});
