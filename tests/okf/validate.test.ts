import { describe, it, expect } from "bun:test";

/**
 * OKF v0.2 §11 conformance. A bundle conforms if:
 *   1. every non-reserved `.md` has parseable YAML frontmatter,
 *   2. every frontmatter has a non-empty `type`,
 *   3. reserved filenames (index.md, log.md) follow their structures.
 *
 * Everything else is soft guidance. In particular the spec forbids rejecting a
 * document for unrecognized keys, unknown types, or broken links — so those
 * MUST NOT surface as errors here.
 */
describe("validateFile", () => {
  it("accepts a concept document with a non-empty type", async () => {
    const { validateFile } = await import("../../src/okf/validate.js");

    const issues = validateFile("tables/orders.md", ["---", "type: BigQuery Table", "---", "body"].join("\n"));

    expect(issues).toEqual([]);
  });

  it("rejects a concept document with no frontmatter block", async () => {
    const { validateFile } = await import("../../src/okf/validate.js");

    const issues = validateFile("tables/orders.md", "# Just a body");

    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("frontmatter-required");
    expect(issues[0]?.path).toBe("tables/orders.md");
  });

  it("rejects a concept document whose type is missing", async () => {
    const { validateFile } = await import("../../src/okf/validate.js");

    const issues = validateFile("tables/orders.md", ["---", "title: Orders", "---", "body"].join("\n"));

    expect(issues.map((i) => i.rule)).toEqual(["type-required"]);
  });

  it("rejects a concept document whose type is blank", async () => {
    const { validateFile } = await import("../../src/okf/validate.js");

    const issues = validateFile("tables/orders.md", ["---", "type: '   '", "---", "body"].join("\n"));

    expect(issues.map((i) => i.rule)).toEqual(["type-required"]);
  });

  it("accepts unrecognized keys and unknown types (§11: MUST NOT reject)", async () => {
    const { validateFile } = await import("../../src/okf/validate.js");

    const issues = validateFile(
      "tables/orders.md",
      ["---", "type: Some Type Nobody Registered", "wat: 1", "---", "[broken](/nope.md)"].join("\n")
    );

    expect(issues).toEqual([]);
  });

  describe("reserved filenames", () => {
    it("accepts an index.md with no frontmatter", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      expect(validateFile("tables/index.md", "# Tables\n* [Orders](orders.md) - one row per order.")).toEqual([]);
    });

    it("rejects a non-root index.md that carries frontmatter", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      const issues = validateFile("tables/index.md", ["---", "type: Index", "---", "# Tables"].join("\n"));

      expect(issues.map((i) => i.rule)).toEqual(["index-frontmatter-forbidden"]);
    });

    it("accepts okf_version on the bundle-root index.md (§12)", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      expect(validateFile("index.md", ["---", 'okf_version: "0.2"', "---", "# Bundle"].join("\n"))).toEqual([]);
    });

    it("rejects any other key on the bundle-root index.md", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      const issues = validateFile("index.md", ["---", 'okf_version: "0.2"', "type: Index", "---", "# Bundle"].join("\n"));

      expect(issues.map((i) => i.rule)).toEqual(["index-frontmatter-forbidden"]);
    });

    it("accepts a log.md with ISO 8601 date headings", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      const raw = ["# Update Log", "## 2026-07-29", "* **Update**: Something.", "## 2026-07-01", "* **Creation**: Init."].join("\n");

      expect(validateFile("log.md", raw)).toEqual([]);
    });

    it("rejects a log.md date heading that is not YYYY-MM-DD", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      const issues = validateFile("log.md", ["# Update Log", "## July 29, 2026", "* **Update**: Something."].join("\n"));

      expect(issues.map((i) => i.rule)).toEqual(["log-date-format"]);
    });

    it("ignores the log.md title heading — only level-2 headings are dates", async () => {
      const { validateFile } = await import("../../src/okf/validate.js");

      expect(validateFile("log.md", "# Directory Update Log")).toEqual([]);
    });
  });
});
