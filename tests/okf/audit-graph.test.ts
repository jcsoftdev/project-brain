import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { auditBundle, impactedConcepts } from "../../src/okf/audit.js";
import type { Bundle, BundleFile } from "../../src/okf/bundle.js";
import type { OkfFrontmatter } from "../../src/okf/types.js";
import type { CodeClock } from "../../src/git/last-changed.js";

const LAYOUT = { bundleRoot: "/repo/okf", repoRoot: "/repo" };

function concept(path: string, frontmatter: OkfFrontmatter, body = "Because."): BundleFile {
  return { path, kind: "concept", raw: "", document: { frontmatter, body } };
}

function bundle(files: BundleFile[]): Bundle {
  return { root: LAYOUT.bundleRoot, okfVersion: "0.2", files, issues: [] };
}

const silentClock: CodeClock = { lastChanged: () => ({ at: null, uncommitted: false }) };
const allOnDisk = () => true;

/** alpha (a.ts) → beta (b.ts) → gamma (c.ts), plus an unrelated helper in a.ts. */
function chainGraph(): GraphStore {
  const store = new GraphStore(openGraphDb(":memory:"));
  store.replaceFile("src/a.ts", "typescript", "h", 0, [
    {
      name: "alpha",
      kind: "function",
      signature: "",
      start_line: 1,
      end_line: 5,
      edges: [{ dst_name: "beta", edge_type: "call" }],
    },
    { name: "helper", kind: "function", signature: "", start_line: 7, end_line: 9, edges: [] },
  ]);
  store.replaceFile("src/b.ts", "typescript", "h", 0, [
    {
      name: "beta",
      kind: "function",
      signature: "",
      start_line: 1,
      end_line: 5,
      edges: [{ dst_name: "gamma", edge_type: "call" }],
    },
  ]);
  store.replaceFile("src/c.ts", "typescript", "h", 0, [
    { name: "gamma", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.resolveEdgesForFiles(["src/a.ts", "src/b.ts", "src/c.ts"]);
  return store;
}

const deps = (graph: GraphStore, coverageLimit?: number) => ({
  graph,
  clock: silentClock,
  exists: allOnDisk,
  coverageLimit,
});

describe("auditBundle — coverage", () => {
  it("ranks the important symbols no concept explains", () => {
    const report = auditBundle(
      bundle([concept("d/a.md", { type: "Decision", resource: "../src/a.ts" })]),
      LAYOUT,
      deps(chainGraph())
    );

    const gaps = report.coverage.map((c) => c.name);
    expect(gaps).toContain("beta");
    expect(gaps).toContain("gamma");
    expect(gaps).not.toContain("alpha");
  });

  it("treats a file-level anchor as covering every symbol in that file", () => {
    // Concepts anchor files far more often than symbols. If a file anchor only
    // covered the file itself, every symbol in an explained file would still be
    // reported as a gap and the backlog would be pure noise.
    const report = auditBundle(
      bundle([concept("d/a.md", { type: "Decision", resource: "../src/a.ts" })]),
      LAYOUT,
      deps(chainGraph())
    );

    expect(report.coverage.map((c) => c.name)).not.toContain("helper");
  });

  it("counts a symbol anchor as covering only that symbol", () => {
    const report = auditBundle(
      bundle([concept("d/a.md", { type: "Decision", resource: "../src/a.ts#alpha" })]),
      LAYOUT,
      deps(chainGraph())
    );

    const gaps = report.coverage.map((c) => c.name);
    expect(gaps).toContain("helper");
    expect(gaps).not.toContain("alpha");
  });

  it("returns gaps in descending rank so the backlog is prioritized", () => {
    const report = auditBundle(bundle([]), LAYOUT, deps(chainGraph()));

    const ranks = report.coverage.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("honours the coverage limit rather than dumping every symbol", () => {
    const report = auditBundle(bundle([]), LAYOUT, deps(chainGraph(), 2));

    expect(report.coverage).toHaveLength(2);
  });

  it("ignores a broken anchor when deciding what is covered", () => {
    // A concept pointing at a deleted file explains nothing that still exists,
    // so its file must go back on the backlog.
    const report = auditBundle(
      bundle([concept("d/a.md", { type: "Decision", resource: "../src/a.ts" })]),
      LAYOUT,
      { graph: chainGraph(), clock: silentClock, exists: (p: string) => p !== "src/a.ts" }
    );

    expect(report.coverage.map((c) => c.name)).toContain("alpha");
  });
});

describe("auditBundle — coverage excludes tests", () => {
  function graphWithTests(): GraphStore {
    const store = new GraphStore(openGraphDb(":memory:"));
    const fn = (name: string) => ({
      name,
      kind: "function",
      signature: "",
      start_line: 1,
      end_line: 5,
      edges: [],
    });
    store.replaceFile("tests/integration/cli.test.ts", "typescript", "h", 0, [fn("spawnCli")]);
    store.replaceFile("src/foo.test.ts", "typescript", "h", 0, [fn("inlineHelper")]);
    store.replaceFile("__tests__/legacy.ts", "typescript", "h", 0, [fn("legacyHelper")]);
    store.replaceFile("spec/thing.ts", "typescript", "h", 0, [fn("specHelper")]);
    store.replaceFile("pkg/thing_test.go", "go", "h", 0, [fn("goHelper")]);
    store.replaceFile("src/latest/release.ts", "typescript", "h", 0, [fn("publish")]);
    store.resolveEdgesForFiles([
      "tests/integration/cli.test.ts",
      "src/foo.test.ts",
      "__tests__/legacy.ts",
      "spec/thing.ts",
      "pkg/thing_test.go",
      "src/latest/release.ts",
    ]);
    return store;
  }

  it("leaves test helpers out of the documentation backlog", () => {
    // PageRank ranks test helpers highly because everything calls them, but a
    // test helper has no *why* worth a concept. Proposing them buries the real
    // gaps under noise.
    const report = auditBundle(bundle([]), LAYOUT, deps(graphWithTests(), 20));

    expect(report.coverage.map((c) => c.name).sort()).toEqual(["publish"]);
  });

  it("does not mistake a directory that merely contains 'test' for a test directory", () => {
    // `src/latest/` is not a test path. Substring matching would silently drop
    // real code from the backlog and nobody would notice it went missing.
    const report = auditBundle(bundle([]), LAYOUT, deps(graphWithTests(), 20));

    expect(report.coverage.map((c) => c.name)).toContain("publish");
  });

  it("still audits an anchor that points at a test file", () => {
    // Knowledge ABOUT a test is legitimate — a gotcha found in a mock belongs in
    // the bundle. Only the backlog skips tests, never the anchor checks.
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/foo.test.ts#inlineHelper" })]),
      LAYOUT,
      deps(graphWithTests())
    );

    expect(report.broken).toEqual([]);
    expect(report.anchors[0]).toMatchObject({ resolution: "ok", range: { start: 1, end: 5 } });
  });
});

describe("auditBundle — link inference", () => {
  it("suggests a link when one concept's code calls another's", () => {
    const report = auditBundle(
      bundle([
        concept("d/a.md", { type: "Decision", resource: "../src/a.ts" }),
        concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }),
      ]),
      LAYOUT,
      deps(chainGraph())
    );

    expect(report.links).toHaveLength(1);
    expect(report.links[0]).toEqual({
      from: "d/a.md",
      to: "d/b.md",
      because: { caller: "alpha", callee: "beta" },
    });
  });

  it("stays quiet when the prose already links the two", () => {
    const report = auditBundle(
      bundle([
        concept("d/a.md", { type: "Decision", resource: "../src/a.ts" }, "See [B](/d/b.md)."),
        concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }),
      ]),
      LAYOUT,
      deps(chainGraph())
    );

    expect(report.links).toEqual([]);
  });

  it("stays quiet when the link exists in the other direction", () => {
    // A pair connected in prose is connected. Nagging about direction would
    // turn a useful signal into a style complaint.
    const report = auditBundle(
      bundle([
        concept("d/a.md", { type: "Decision", resource: "../src/a.ts" }),
        concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }, "See [A](/d/a.md)."),
      ]),
      LAYOUT,
      deps(chainGraph())
    );

    expect(report.links).toEqual([]);
  });

  it("never suggests a concept link to itself", () => {
    const report = auditBundle(
      bundle([
        concept("d/a.md", {
          type: "Decision",
          resource: "../src/a.ts",
          sources: [{ resource: "../src/b.ts" }],
        }),
      ]),
      LAYOUT,
      deps(chainGraph())
    );

    expect(report.links).toEqual([]);
  });

  it("suggests a pair once, not once per direction", () => {
    // Mutual recursion across two files. Direction is not what the suggestion is
    // about — `alreadyLinked` already ignores it — so emitting both is noise.
    const graph = new GraphStore(openGraphDb(":memory:"));
    graph.replaceFile("src/x.ts", "typescript", "h", 0, [
      {
        name: "xs",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "ys", edge_type: "call" }],
      },
    ]);
    graph.replaceFile("src/y.ts", "typescript", "h", 0, [
      {
        name: "ys",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "xs", edge_type: "call" }],
      },
    ]);
    graph.resolveEdgesForFiles(["src/x.ts", "src/y.ts"]);

    const report = auditBundle(
      bundle([
        concept("d/x.md", { type: "Decision", resource: "../src/x.ts" }),
        concept("d/y.md", { type: "Decision", resource: "../src/y.ts" }),
      ]),
      LAYOUT,
      deps(graph)
    );

    expect(report.links).toHaveLength(1);
  });

  it("stays quiet when both concepts already cover both ends of the edge", () => {
    // Two concepts anchoring the SAME file cover an identical symbol set, so
    // every call inside that file yields a suggestion between them — in both
    // directions. The edge says nothing about a relationship they do not already
    // have: they share a file.
    const graph = new GraphStore(openGraphDb(":memory:"));
    graph.replaceFile("src/one.ts", "typescript", "h", 0, [
      {
        name: "outer",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "inner", edge_type: "call" }],
      },
      { name: "inner", kind: "function", signature: "", start_line: 7, end_line: 9, edges: [] },
    ]);
    graph.resolveEdgesForFile("src/one.ts");

    const report = auditBundle(
      bundle([
        concept("d/a.md", { type: "Decision", resource: "../src/one.ts" }),
        concept("d/b.md", { type: "Decision", resource: "../src/one.ts" }),
      ]),
      LAYOUT,
      deps(graph)
    );

    expect(report.links).toEqual([]);
  });

  it("still suggests a pair for an edge inside one file when each concept owns one end", () => {
    // The twin of the suppression above, placed right at its boundary: same file,
    // same edge shape, but the concepts own DIFFERENT ends of it. Suppressing on
    // "caller and callee share a file" — the naive fix — would swallow this.
    const graph = new GraphStore(openGraphDb(":memory:"));
    graph.replaceFile("src/one.ts", "typescript", "h", 0, [
      {
        name: "outer",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "inner", edge_type: "call" }],
      },
      { name: "inner", kind: "function", signature: "", start_line: 7, end_line: 9, edges: [] },
    ]);
    graph.resolveEdgesForFile("src/one.ts");

    const report = auditBundle(
      bundle([
        concept("d/outer.md", { type: "Decision", resource: "../src/one.ts#outer" }),
        concept("d/inner.md", { type: "Decision", resource: "../src/one.ts#inner" }),
      ]),
      LAYOUT,
      deps(graph)
    );

    expect(report.links).toEqual([
      { from: "d/outer.md", to: "d/inner.md", because: { caller: "outer", callee: "inner" } },
    ]);
  });

  it("suggests a broad concept link to the specific one that owns the callee", () => {
    // Pins the suppression rule to BOTH-cover-BOTH, not either-covers-either.
    // Here a file-level concept covers the whole edge while a symbol-level one
    // covers just the callee: the broad note should point at the specific note.
    const graph = new GraphStore(openGraphDb(":memory:"));
    graph.replaceFile("src/one.ts", "typescript", "h", 0, [
      {
        name: "outer",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "inner", edge_type: "call" }],
      },
      { name: "inner", kind: "function", signature: "", start_line: 7, end_line: 9, edges: [] },
    ]);
    graph.resolveEdgesForFile("src/one.ts");

    const report = auditBundle(
      bundle([
        concept("d/file.md", { type: "Decision", resource: "../src/one.ts" }),
        concept("d/inner.md", { type: "Decision", resource: "../src/one.ts#inner" }),
      ]),
      LAYOUT,
      deps(graph)
    );

    expect(report.links).toEqual([
      { from: "d/file.md", to: "d/inner.md", because: { caller: "outer", callee: "inner" } },
    ]);
  });

  it("suggests each pair once even when several call edges connect them", () => {
    const graph = chainGraph();
    graph.replaceFile("src/a.ts", "typescript", "h", 0, [
      {
        name: "alpha",
        kind: "function",
        signature: "",
        start_line: 1,
        end_line: 5,
        edges: [{ dst_name: "beta", edge_type: "call" }],
      },
      {
        name: "helper",
        kind: "function",
        signature: "",
        start_line: 7,
        end_line: 9,
        edges: [{ dst_name: "beta", edge_type: "call" }],
      },
    ]);
    graph.resolveEdgesForFiles(["src/a.ts", "src/b.ts", "src/c.ts"]);

    const report = auditBundle(
      bundle([
        concept("d/a.md", { type: "Decision", resource: "../src/a.ts" }),
        concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }),
      ]),
      LAYOUT,
      deps(graph)
    );

    expect(report.links).toHaveLength(1);
  });
});

describe("impactedConcepts", () => {
  const twoConcepts = bundle([
    concept("d/a.md", { type: "Decision", resource: "../src/a.ts" }),
    concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }),
    concept("d/c.md", { type: "Decision", resource: "../src/c.ts" }),
  ]);

  it("lists every concept explaining code that transitively calls the changed symbol", () => {
    const impacted = impactedConcepts("gamma", twoConcepts, LAYOUT, {
      graph: chainGraph(),
      exists: allOnDisk,
    });

    expect(impacted.map((i) => i.concept).sort()).toEqual(["d/a.md", "d/b.md", "d/c.md"]);
  });

  it("includes the concept anchoring the changed symbol itself, which needs re-reading most", () => {
    const impacted = impactedConcepts("gamma", twoConcepts, LAYOUT, {
      graph: chainGraph(),
      exists: allOnDisk,
    });

    expect(impacted.find((i) => i.concept === "d/c.md")?.via).toEqual({
      name: "gamma",
      file: "src/c.ts",
    });
  });

  it("returns nothing for a symbol no concept reaches", () => {
    const impacted = impactedConcepts("helper", bundle([
      concept("d/b.md", { type: "Decision", resource: "../src/b.ts" }),
    ]), LAYOUT, { graph: chainGraph(), exists: allOnDisk });

    expect(impacted).toEqual([]);
  });

  it("returns nothing for a symbol the graph does not know", () => {
    const impacted = impactedConcepts("nonexistent", twoConcepts, LAYOUT, {
      graph: chainGraph(),
      exists: allOnDisk,
    });

    expect(impacted).toEqual([]);
  });

  it("reports a concept once even when it explains several impacted symbols", () => {
    const impacted = impactedConcepts("gamma", bundle([
      concept("d/all.md", {
        type: "Decision",
        resource: "../src/a.ts",
        sources: [{ resource: "../src/b.ts" }],
      }),
    ]), LAYOUT, { graph: chainGraph(), exists: allOnDisk });

    expect(impacted.map((i) => i.concept)).toEqual(["d/all.md"]);
  });
});
