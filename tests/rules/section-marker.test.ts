import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  writeSection,
  removeSection,
  hasSection,
  formatSectionWriteSummary,
} from "../../src/rules/section-marker.js";

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

  // T6 — an agent reported `okf init` rewrote 51 lines of CLAUDE.md silently.
  // writeSection now returns a change summary so callers can print what changed.
  describe("writeSection change summary", () => {
    it("reports the file, lines added, and outsideBlockUnchanged=true on first write (append)", async () => {
      await Bun.write(filePath, "# Header\n\nUser content here.\n");
      const summary = await writeSection(filePath, "line one\nline two");

      expect(summary.file).toBe(filePath);
      expect(summary.linesAdded).toBeGreaterThan(0);
      expect(summary.linesRemoved).toBe(0);
      expect(summary.unchanged).toBe(false);
      expect(summary.outsideBlockUnchanged).toBe(true);
    });

    it("reports lines added and removed when replacing an existing section", async () => {
      await writeSection(filePath, "a\nb\nc");
      const summary = await writeSection(filePath, "x\ny");

      expect(summary.linesRemoved).toBeGreaterThan(0);
      expect(summary.linesAdded).toBeGreaterThan(0);
      expect(summary.outsideBlockUnchanged).toBe(true);
    });

    it("reports unchanged=true when rewriting with identical content", async () => {
      await writeSection(filePath, "same content");
      const summary = await writeSection(filePath, "same content");

      expect(summary.unchanged).toBe(true);
      expect(summary.linesAdded).toBe(0);
      expect(summary.linesRemoved).toBe(0);
    });

    it("outsideBlockUnchanged stays true even though the outside content is untouched by a normal rewrite", async () => {
      await Bun.write(filePath, "# My own header\n\nMy own paragraph.\n");
      await writeSection(filePath, "v1");
      const summary = await writeSection(filePath, "v2 has more lines\nline two\nline three");

      expect(summary.outsideBlockUnchanged).toBe(true);
      const content = await Bun.file(filePath).text();
      expect(content).toContain("# My own header");
      expect(content).toContain("My own paragraph.");
    });
  });

  describe("formatSectionWriteSummary", () => {
    it('formats an unchanged write as "<file>: unchanged"', () => {
      const line = formatSectionWriteSummary({
        file: "/x/CLAUDE.md",
        linesAdded: 0,
        linesRemoved: 0,
        unchanged: true,
        outsideBlockUnchanged: true,
      });
      expect(line).toBe("CLAUDE.md: unchanged");
    });

    it("formats a changed write with +added -removed and the outside-unchanged note", () => {
      const line = formatSectionWriteSummary({
        file: "/x/CLAUDE.md",
        linesAdded: 3,
        linesRemoved: 51,
        unchanged: false,
        outsideBlockUnchanged: true,
      });
      expect(line).toBe(
        "CLAUDE.md: project-brain block updated (+3 −51); content outside the block unchanged"
      );
    });

    it("warns when content outside the block changed", () => {
      const line = formatSectionWriteSummary({
        file: "/x/CLAUDE.md",
        linesAdded: 1,
        linesRemoved: 1,
        unchanged: false,
        outsideBlockUnchanged: false,
      });
      expect(line).toContain("WARNING");
      expect(line).toContain("outside the block");
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

  describe("sectionId param (multiple independent sections per file)", () => {
    it("writes two independent sections into the same file, each under its own markers", async () => {
      await writeSection(filePath, "Default section content");
      await writeSection(filePath, "Model routing content", "project-brain-model-routing");

      const content = await Bun.file(filePath).text();
      expect(content).toContain("<!-- project-brain:start -->");
      expect(content).toContain("Default section content");
      expect(content).toContain("<!-- project-brain:end -->");
      expect(content).toContain("<!-- project-brain-model-routing:start -->");
      expect(content).toContain("Model routing content");
      expect(content).toContain("<!-- project-brain-model-routing:end -->");
    });

    it("replacing one section leaves the other section untouched", async () => {
      await writeSection(filePath, "Default v1");
      await writeSection(filePath, "Routing v1", "project-brain-model-routing");
      await writeSection(filePath, "Default v2");

      const content = await Bun.file(filePath).text();
      expect(content).not.toContain("Default v1");
      expect(content).toContain("Default v2");
      expect(content).toContain("Routing v1");
    });

    it("removing one section by id leaves the other section untouched", async () => {
      await writeSection(filePath, "Default content");
      await writeSection(filePath, "Routing content", "project-brain-model-routing");

      const removed = await removeSection(filePath, "project-brain-model-routing");
      expect(removed).toBe(true);

      const content = await Bun.file(filePath).text();
      expect(content).not.toContain("<!-- project-brain-model-routing:start -->");
      expect(content).not.toContain("Routing content");
      expect(content).toContain("<!-- project-brain:start -->");
      expect(content).toContain("Default content");
    });
  });

  describe("hasSection", () => {
    it("returns false if the file does not exist", async () => {
      const result = await hasSection(join(tempDir, "nonexistent.md"));
      expect(result).toBe(false);
    });

    it("returns false if the marker is absent", async () => {
      await Bun.write(filePath, "No markers here.\n");
      const result = await hasSection(filePath);
      expect(result).toBe(false);
    });

    it("returns true if the default section marker is present", async () => {
      await writeSection(filePath, "Some content");
      const result = await hasSection(filePath);
      expect(result).toBe(true);
    });

    it("is independent per sectionId — one section present does not count as another", async () => {
      await writeSection(filePath, "Default content");

      expect(await hasSection(filePath)).toBe(true);
      expect(await hasSection(filePath, "project-brain-model-routing")).toBe(false);
    });

    it("returns true for a custom sectionId once written", async () => {
      await writeSection(filePath, "Routing content", "project-brain-model-routing");
      const result = await hasSection(filePath, "project-brain-model-routing");
      expect(result).toBe(true);
    });
  });
});
