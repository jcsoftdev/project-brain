import { describe, it, expect } from "bun:test";

/**
 * Pure string operations over a managed block:
 *
 *   <!-- project-brain:start -->
 *   ...machine-owned content...
 *   <!-- project-brain:end -->
 *
 * Everything outside the block is human-owned and MUST survive a rewrite. These
 * are extracted from src/rules/section-marker.ts (which owns the filesystem
 * side) so the OKF exporter and the AI-rules writers agree on one marker format.
 */
describe("markers", () => {
  const START = "<!-- project-brain:start -->";
  const END = "<!-- project-brain:end -->";

  describe("extractSection", () => {
    it("returns the content between the markers", async () => {
      const { extractSection } = await import("../src/markers.js");

      const text = ["# Why", "Curated.", START, "derived line", END, "trailing"].join("\n");

      expect(extractSection(text)).toBe("derived line");
    });

    it("returns null when no managed block is present", async () => {
      const { extractSection } = await import("../src/markers.js");

      expect(extractSection("# Why\nCurated.")).toBeNull();
    });

    it("returns an empty string for a present but empty block", async () => {
      const { extractSection } = await import("../src/markers.js");

      expect(extractSection([START, END].join("\n"))).toBe("");
    });
  });

  describe("replaceSection", () => {
    it("replaces an existing block in place, preserving surrounding content", async () => {
      const { replaceSection } = await import("../src/markers.js");

      const text = ["# Why", "Curated.", START, "old", END, "# After", "More."].join("\n");

      expect(replaceSection(text, "new")).toBe(
        ["# Why", "Curated.", START, "new", END, "# After", "More."].join("\n")
      );
    });

    it("appends the block when the text has none", async () => {
      const { replaceSection } = await import("../src/markers.js");

      expect(replaceSection("# Why\nCurated.", "derived")).toBe(
        ["# Why", "Curated.", "", START, "derived", END].join("\n")
      );
    });

    it("returns just the block when the text is empty", async () => {
      const { replaceSection } = await import("../src/markers.js");

      expect(replaceSection("", "derived")).toBe([START, "derived", END].join("\n"));
    });

    it("is idempotent — replacing with the same content changes nothing", async () => {
      const { replaceSection } = await import("../src/markers.js");

      const once = replaceSection("# Why\nCurated.", "derived");

      expect(replaceSection(once, "derived")).toBe(once);
    });

    it("honors a custom section id so independent blocks coexist", async () => {
      const { replaceSection, extractSection } = await import("../src/markers.js");

      const withA = replaceSection("", "a-content", "block-a");
      const withBoth = replaceSection(withA, "b-content", "block-b");

      expect(extractSection(withBoth, "block-a")).toBe("a-content");
      expect(extractSection(withBoth, "block-b")).toBe("b-content");
    });
  });

  describe("stripSection", () => {
    it("removes the managed block and leaves the curated remainder", async () => {
      const { stripSection } = await import("../src/markers.js");

      const text = ["# Why", "Curated.", START, "derived", END, "# After"].join("\n");

      expect(stripSection(text)).toBe(["# Why", "Curated.", "# After"].join("\n"));
    });

    it("returns the text unchanged when no managed block is present", async () => {
      const { stripSection } = await import("../src/markers.js");

      expect(stripSection("# Why\nCurated.")).toBe("# Why\nCurated.");
    });
  });
});
