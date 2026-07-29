import { describe, it, expect } from "bun:test";

/**
 * Rendering MUST be a pure function of the document's *logical* content.
 *
 * This is the anti-churn requirement: the exporter rewrites the bundle on every
 * sync, so if key insertion order (or any other incidental detail) leaked into
 * the output, every file would show up dirty in git on every run and the bundle
 * would be useless to version. Two documents that mean the same thing MUST
 * render to identical bytes.
 */
describe("renderDocument", () => {
  it("emits frontmatter keys in canonical order regardless of insertion order", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");

    const a = renderDocument({
      frontmatter: { title: "Orders", type: "Module", description: "One row per order." },
      body: "# Why",
    });
    const b = renderDocument({
      frontmatter: { description: "One row per order.", type: "Module", title: "Orders" },
      body: "# Why",
    });

    expect(a).toBe(b);
    expect(a).toBe(
      ["---", "type: Module", "title: Orders", "description: One row per order.", "---", "", "# Why", ""].join("\n")
    );
  });

  it("sorts unrecognized keys alphabetically after the known ones", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");

    const out = renderDocument({
      frontmatter: { z_custom: "z", type: "Module", a_custom: "a" },
      body: "body",
    });

    expect(out).toBe(["---", "type: Module", "a_custom: a", "z_custom: z", "---", "", "body", ""].join("\n"));
  });

  it("omits keys whose value is undefined, null, or an empty list", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");

    const out = renderDocument({
      frontmatter: { type: "Module", title: undefined, tags: [], sources: [], verified: undefined },
      body: "body",
    });

    expect(out).toBe(["---", "type: Module", "---", "", "body", ""].join("\n"));
  });

  it("round-trips through parseDocument without losing fields", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const doc = {
      frontmatter: {
        type: "Symbol",
        title: "handleAdr",
        resource: "/src/tools/adr.ts",
        tags: ["tools", "adr"],
        status: "stable" as const,
        sources: [{ resource: "/src/tools/adr.ts", last_modified: "2026-07-24" }],
        generated: { by: "project-brain/0.15.0", at: "2026-07-29T10:00:00Z" },
        verified: [{ by: "human:jcsoftdev", at: "2026-07-29T11:20:00Z" }],
      },
      body: "# Why\nAppend-only.",
    };

    expect(parseDocument(renderDocument(doc))).toEqual(doc);
  });

  it("is idempotent — re-rendering a parsed document reproduces the same bytes", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");
    const { parseDocument } = await import("../../src/okf/frontmatter.js");

    const once = renderDocument({
      frontmatter: { type: "Module", tags: ["b", "a"], generated: { by: "project-brain/0.15.0", at: "2026-07-29T10:00:00Z" } },
      body: "# Why\n\nText.",
    });

    expect(renderDocument(parseDocument(once))).toBe(once);
  });

  it("renders a document with no frontmatter as a bare body (reserved index.md/log.md)", async () => {
    const { renderDocument } = await import("../../src/okf/render.js");

    expect(renderDocument({ frontmatter: {}, body: "# Index\n* [a](a.md)" })).toBe("# Index\n* [a](a.md)\n");
  });
});
