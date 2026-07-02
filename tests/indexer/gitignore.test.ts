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
  });
});
