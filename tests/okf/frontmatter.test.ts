import { describe, it, expect } from "bun:test";

/**
 * OKF v0.2 §3-4: a concept document is a YAML frontmatter block delimited by
 * `---` lines at the start of the file, followed by a free-form markdown body.
 *
 * Parsing MUST be tolerant (§11): a consumer never rejects a document for
 * missing optional fields or unrecognized keys. Validation is a separate step.
 */
describe("parseDocument", () => {
  it("splits frontmatter from body", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument(
      ["---", "type: Module", "title: ADR tooling", "---", "", "# Why", "Append-only."].join("\n")
    );

    expect(doc.frontmatter.type).toBe("Module");
    expect(doc.frontmatter.title).toBe("ADR tooling");
    expect(doc.body).toBe("# Why\nAppend-only.");
  });

  it("preserves unrecognized frontmatter keys", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument(["---", "type: Module", "x_custom: keep-me", "---", "body"].join("\n"));

    expect(doc.frontmatter.x_custom).toBe("keep-me");
  });

  it("returns an empty frontmatter for a document with no frontmatter block", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument("# Just a body\n");

    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("# Just a body");
  });

  it("returns an empty frontmatter when the YAML block is malformed", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument(["---", "type: [unclosed", "---", "body"].join("\n"));

    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("body");
  });

  it("parses the nested generated/verified trust fields (§5.2)", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument(
      [
        "---",
        "type: Symbol",
        "generated: { by: project-brain/0.15.0, at: 2026-07-29T10:00:00Z }",
        "verified:",
        "  - by: human:jcsoftdev",
        "    at: 2026-07-29T11:20:00Z",
        "---",
        "body",
      ].join("\n")
    );

    expect(doc.frontmatter.generated).toEqual({ by: "project-brain/0.15.0", at: "2026-07-29T10:00:00Z" });
    expect(doc.frontmatter.verified).toEqual([{ by: "human:jcsoftdev", at: "2026-07-29T11:20:00Z" }]);
  });

  it("normalizes a bare `verified` mapping into a single-element list (§11)", async () => {
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = parseDocument(
      ["---", "type: Symbol", "verified: { by: human:jcsoftdev, at: 2026-07-29T11:20:00Z }", "---", "body"].join("\n")
    );

    expect(doc.frontmatter.verified).toEqual([{ by: "human:jcsoftdev", at: "2026-07-29T11:20:00Z" }]);
  });
});
