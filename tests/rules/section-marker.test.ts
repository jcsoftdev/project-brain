import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeSection, removeSection } from "../../src/rules/section-marker.js";

describe("section-marker", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "section-marker-"));
    filePath = join(tempDir, "test.md");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("writeSection", () => {
    it("creates file with section if file does not exist", async () => {
      await writeSection(filePath, "Hello content");

      const content = await Bun.file(filePath).text();
      expect(content).toContain("<!-- project-brain:start -->");
      expect(content).toContain("Hello content");
      expect(content).toContain("<!-- project-brain:end -->");
    });

    it("appends section to file with existing content", async () => {
      await Bun.write(filePath, "# Existing header\n\nSome text.\n");

      await writeSection(filePath, "New section content");

      const content = await Bun.file(filePath).text();
      expect(content).toContain("# Existing header");
      expect(content).toContain("Some text.");
      expect(content).toContain("<!-- project-brain:start -->");
      expect(content).toContain("New section content");
      expect(content).toContain("<!-- project-brain:end -->");
    });

    it("replaces existing section (idempotent)", async () => {
      await writeSection(filePath, "First version");
      await writeSection(filePath, "Second version");

      const content = await Bun.file(filePath).text();
      expect(content).not.toContain("First version");
      expect(content).toContain("Second version");
      // Only one start marker
      const starts = content.split("<!-- project-brain:start -->").length - 1;
      expect(starts).toBe(1);
    });

    it("does not clobber content outside markers", async () => {
      await Bun.write(filePath, "# Header\n\nUser content here.\n");
      await writeSection(filePath, "Brain section");

      const content = await Bun.file(filePath).text();
      expect(content).toContain("# Header");
      expect(content).toContain("User content here.");
      expect(content).toContain("Brain section");
    });
  });

  describe("removeSection", () => {
    it("removes the marked section", async () => {
      await Bun.write(
        filePath,
        "Before\n\n<!-- project-brain:start -->\nStuff\n<!-- project-brain:end -->\n\nAfter\n"
      );

      const removed = await removeSection(filePath);
      expect(removed).toBe(true);

      const content = await Bun.file(filePath).text();
      expect(content).not.toContain("<!-- project-brain:start -->");
      expect(content).not.toContain("Stuff");
      expect(content).not.toContain("<!-- project-brain:end -->");
      expect(content).toContain("Before");
      expect(content).toContain("After");
    });

    it("returns false if no section found", async () => {
      await Bun.write(filePath, "No markers here.\n");

      const removed = await removeSection(filePath);
      expect(removed).toBe(false);
    });

    it("returns false if file does not exist", async () => {
      const removed = await removeSection(join(tempDir, "nonexistent.md"));
      expect(removed).toBe(false);
    });
  });
});
