import { describe, it, expect } from "bun:test";
import { parseResource, collectAnchors } from "../../src/okf/anchors.js";
import type { Bundle, BundleFile } from "../../src/okf/bundle.js";
import type { OkfFrontmatter } from "../../src/okf/types.js";

function concept(path: string, frontmatter: OkfFrontmatter, body = "Because."): BundleFile {
  return { path, kind: "concept", raw: "", document: { frontmatter, body } };
}

function bundle(files: BundleFile[]): Bundle {
  return { root: "/repo/okf", okfVersion: "0.2", files, issues: [] };
}

const LAYOUT = { bundleRoot: "/repo/okf", repoRoot: "/repo" };

describe("parseResource", () => {
  it("reads a bare path with no fragment", () => {
    expect(parseResource("../src/parser/wasm.ts")).toEqual({
      path: "../src/parser/wasm.ts",
      symbol: null,
      lines: null,
    });
  });

  it("reads a symbol fragment", () => {
    expect(parseResource("../src/parser/wasm.ts#loadGrammar")).toEqual({
      path: "../src/parser/wasm.ts",
      symbol: "loadGrammar",
      lines: null,
    });
  });

  it("reads an L-prefixed line range", () => {
    expect(parseResource("../src/parser/wasm.ts#L10-L25")).toEqual({
      path: "../src/parser/wasm.ts",
      symbol: null,
      lines: { start: 10, end: 25 },
    });
  });

  it("reads a single-line range as a one-line span", () => {
    expect(parseResource("../src/parser/wasm.ts#L42")).toEqual({
      path: "../src/parser/wasm.ts",
      symbol: null,
      lines: { start: 42, end: 42 },
    });
  });

  it("rejects a reversed line range rather than inventing a span", () => {
    // A backwards range is a typo, not a request. Treating it as a symbol named
    // "L25-L10" would silently look up something that cannot exist.
    expect(parseResource("../src/a.ts#L25-L10")).toBeNull();
  });

  it("returns null for a URL, which is external material and not a repo anchor", () => {
    expect(parseResource("https://example.com/spec#section")).toBeNull();
  });

  it("returns null for an empty resource", () => {
    expect(parseResource("   ")).toBeNull();
  });
});

describe("collectAnchors", () => {
  it("resolves a bundle-root-relative resource to a repo-relative path", () => {
    // The bundle already uses root-relative links in bodies (/decisions/x.md),
    // so `resource` shares that base rather than being document-relative.
    const anchors = collectAnchors(
      bundle([concept("gotchas/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts" })]),
      LAYOUT
    );

    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      concept: "gotchas/a.md",
      path: "src/parser/wasm.ts",
      symbol: null,
      origin: "resource",
    });
  });

  it("collects every sources[] entry alongside the top-level resource", () => {
    const anchors = collectAnchors(
      bundle([
        concept("decisions/a.md", {
          type: "Decision",
          resource: "../src/okf/route.ts",
          sources: [{ resource: "../src/commands/sync.ts" }, { resource: "../src/okf/sync.ts" }],
        }),
      ]),
      LAYOUT
    );

    expect(anchors.map((a) => a.path)).toEqual([
      "src/okf/route.ts",
      "src/commands/sync.ts",
      "src/okf/sync.ts",
    ]);
    expect(anchors.map((a) => a.origin)).toEqual(["resource", "sources", "sources"]);
  });

  it("keeps the symbol fragment on the anchor", () => {
    const anchors = collectAnchors(
      bundle([concept("gotchas/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts#loadGrammar" })]),
      LAYOUT
    );

    expect(anchors[0]).toMatchObject({ path: "src/parser/wasm.ts", symbol: "loadGrammar" });
  });

  it("skips a concept with no resource and no sources", () => {
    const anchors = collectAnchors(
      bundle([concept("constraints/a.md", { type: "Constraint", title: "No anchor" })]),
      LAYOUT
    );

    expect(anchors).toEqual([]);
  });

  it("skips index, log and reference files, which never anchor code", () => {
    const files: BundleFile[] = [
      { ...concept("index.md", { resource: "../src/a.ts" }), kind: "index" },
      { ...concept("log.md", { resource: "../src/b.ts" }), kind: "log" },
      { ...concept("references/x.md", { type: "Reference", resource: "../src/c.ts" }), kind: "reference" },
    ];

    expect(collectAnchors(bundle(files), LAYOUT)).toEqual([]);
  });

  it("drops a resource that escapes the repo root instead of emitting a ../ path", () => {
    // Nothing outside the repo is in the graph, so an anchor pointing there can
    // never resolve — reporting it as unresolved would be noise, not a finding.
    const anchors = collectAnchors(
      bundle([concept("gotchas/a.md", { type: "Gotcha", resource: "../../elsewhere/x.ts" })]),
      LAYOUT
    );

    expect(anchors).toEqual([]);
  });

  it("drops external URLs, which are provenance rather than code anchors", () => {
    const anchors = collectAnchors(
      bundle([
        concept("decisions/a.md", {
          type: "Decision",
          sources: [{ resource: "https://example.com/spec" }, { resource: "../src/a.ts" }],
        }),
      ]),
      LAYOUT
    );

    expect(anchors.map((a) => a.path)).toEqual(["src/a.ts"]);
  });

  it("ignores a malformed sources entry rather than throwing", () => {
    // §11: a consumer must not reject a document for bad optional data.
    const anchors = collectAnchors(
      bundle([
        concept("decisions/a.md", {
          type: "Decision",
          sources: [null, "not-an-object", { title: "no resource" }, { resource: "../src/a.ts" }] as never,
        }),
      ]),
      LAYOUT
    );

    expect(anchors.map((a) => a.path)).toEqual(["src/a.ts"]);
  });

  it("carries the concept's own repo-relative path, so its commit date can be read too", () => {
    // A concept's declared attestation is author-written and easy to get wrong.
    // Its file's commit date is objective, and lands in the same commit as the
    // code when the two are written together — which is the normal case.
    const anchors = collectAnchors(
      bundle([concept("gotchas/a.md", { type: "Gotcha", resource: "../src/a.ts" })]),
      LAYOUT
    );

    expect(anchors[0].conceptPath).toBe("okf/gotchas/a.md");
  });

  it("carries the concept's newest attestation time so staleness has a baseline", () => {
    // `verified` outranks `generated`: a human re-reading the note after the
    // code moved is exactly the event that clears staleness.
    const anchors = collectAnchors(
      bundle([
        concept("gotchas/a.md", {
          type: "Gotcha",
          resource: "../src/a.ts",
          generated: { by: "human:jcsoftdev", at: "2026-01-01T00:00:00Z" },
          verified: [{ by: "human:jcsoftdev", at: "2026-06-01T00:00:00Z" }],
        }),
      ]),
      LAYOUT
    );

    expect(anchors[0].attestedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("falls back to generated.at when nothing has been verified", () => {
    const anchors = collectAnchors(
      bundle([
        concept("gotchas/a.md", {
          type: "Gotcha",
          resource: "../src/a.ts",
          generated: { by: "human:jcsoftdev", at: "2026-01-01T00:00:00Z" },
        }),
      ]),
      LAYOUT
    );

    expect(anchors[0].attestedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("reports no attestation at all as null rather than a fake epoch", () => {
    const anchors = collectAnchors(
      bundle([concept("gotchas/a.md", { type: "Gotcha", resource: "../src/a.ts" })]),
      LAYOUT
    );

    expect(anchors[0].attestedAt).toBeNull();
  });
});
