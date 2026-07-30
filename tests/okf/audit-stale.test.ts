import { describe, it, expect } from "bun:test";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { auditBundle } from "../../src/okf/audit.js";
import type { Bundle, BundleFile } from "../../src/okf/bundle.js";
import type { OkfFrontmatter } from "../../src/okf/types.js";
import type { CodeChange, CodeClock, LineRange } from "../../src/git/last-changed.js";

const LAYOUT = { bundleRoot: "/repo/okf", repoRoot: "/repo" };

function concept(path: string, frontmatter: OkfFrontmatter, body = "Because."): BundleFile {
  return { path, kind: "concept", raw: "", document: { frontmatter, body } };
}

function bundle(files: BundleFile[]): Bundle {
  return { root: LAYOUT.bundleRoot, okfVersion: "0.2", files, issues: [] };
}

/** A graph holding one file with two symbols, one calling the other. */
function graphWithLoader(): GraphStore {
  const store = new GraphStore(openGraphDb(":memory:"));
  store.replaceFile("src/parser/wasm.ts", "typescript", "h", 0, [
    { name: "loadGrammar", kind: "function", signature: "", start_line: 10, end_line: 25, edges: [] },
    {
      name: "warm",
      kind: "function",
      signature: "",
      start_line: 30,
      end_line: 40,
      edges: [{ dst_name: "loadGrammar", edge_type: "call" }],
    },
  ]);
  store.resolveEdgesForFile("src/parser/wasm.ts");
  return store;
}

/** Records the range each query used, so range precision is observable. */
function clockOf(
  answers: Record<string, CodeChange>,
  seen: { path: string; lines: LineRange | null }[] = []
): CodeClock & { seen: typeof seen } {
  return {
    seen,
    lastChanged(path: string, lines?: LineRange | null): CodeChange {
      seen.push({ path, lines: lines ?? null });
      return answers[path] ?? { at: null, uncommitted: false };
    },
  };
}

const onDisk = (...paths: string[]) => (p: string) => paths.includes(p);

describe("auditBundle — anchor resolution", () => {
  it("resolves an anchor whose file is present", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts" })]),
      LAYOUT,
      { graph: graphWithLoader(), clock: clockOf({}), exists: onDisk("src/parser/wasm.ts") }
    );

    expect(report.anchors).toHaveLength(1);
    expect(report.anchors[0].resolution).toBe("ok");
    expect(report.broken).toEqual([]);
  });

  it("reports an anchor to a file that no longer exists", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/moved.ts" })]),
      LAYOUT,
      { graph: graphWithLoader(), clock: clockOf({}), exists: onDisk("src/parser/wasm.ts") }
    );

    expect(report.broken).toHaveLength(1);
    expect(report.broken[0]).toMatchObject({ concept: "g/a.md", resolution: "missing-file" });
  });

  it("reports a symbol anchor whose symbol is gone even though the file survives", () => {
    // The sharpest broken anchor: the file still exists, so nothing else in the
    // toolchain notices, but the explanation now points at nothing.
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts#renamedAway" })]),
      LAYOUT,
      { graph: graphWithLoader(), clock: clockOf({}), exists: onDisk("src/parser/wasm.ts") }
    );

    expect(report.broken).toHaveLength(1);
    expect(report.broken[0]).toMatchObject({ resolution: "missing-symbol", symbol: "renamedAway" });
  });

  it("takes the line span of a symbol anchor from the graph", () => {
    const clock = clockOf({});
    auditBundle(
      bundle([
        concept("g/a.md", {
          type: "Gotcha",
          resource: "../src/parser/wasm.ts#loadGrammar",
          generated: { by: "human:jcsoftdev", at: "2026-01-01T00:00:00Z" },
        }),
      ]),
      LAYOUT,
      { graph: graphWithLoader(), clock, exists: onDisk("src/parser/wasm.ts") }
    );

    // The concept's own file is asked for too, whole-file: its commit date is
    // half of the staleness baseline.
    expect(clock.seen).toEqual([
      { path: "okf/g/a.md", lines: null },
      { path: "src/parser/wasm.ts", lines: { start: 10, end: 25 } },
    ]);
  });

  it("does not call a symbol missing when the graph holds no symbols for that file at all", () => {
    // Only source languages the parser understands land in the graph. A concept
    // anchoring `#Heading` in a markdown file, or any file whose language is not
    // parsed, must not be reported broken just because the graph is silent.
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../docs/design.md#Rationale" })]),
      LAYOUT,
      { graph: graphWithLoader(), clock: clockOf({}), exists: onDisk("docs/design.md") }
    );

    expect(report.broken).toEqual([]);
    expect(report.anchors[0]).toMatchObject({ resolution: "ok", range: null });
  });

  it("prefers an explicit line range over the symbol table", () => {
    const clock = clockOf({});
    auditBundle(
      bundle([
        concept("g/a.md", {
          type: "Gotcha",
          resource: "../src/parser/wasm.ts#L4-L8",
          generated: { by: "human:jcsoftdev", at: "2026-01-01T00:00:00Z" },
        }),
      ]),
      LAYOUT,
      { graph: graphWithLoader(), clock, exists: onDisk("src/parser/wasm.ts") }
    );

    expect(clock.seen).toEqual([
      { path: "okf/g/a.md", lines: null },
      { path: "src/parser/wasm.ts", lines: { start: 4, end: 8 } },
    ]);
  });
});

describe("auditBundle — staleness", () => {
  const attested = (at: string): OkfFrontmatter => ({
    type: "Gotcha",
    resource: "../src/parser/wasm.ts",
    generated: { by: "human:jcsoftdev", at },
  });

  it("flags a concept whose code changed after it was attested", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-01-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({
      concept: "g/a.md",
      reason: "code-changed",
      attestedAt: "2026-01-01T00:00:00Z",
      changedAt: "2026-06-01T00:00:00Z",
    });
  });

  it("leaves a concept alone when the code has not moved since it was attested", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-06-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-01-01T00:00:00Z", uncommitted: false } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
  });

  it("clears staleness when a human re-verified after the change", () => {
    // `verified` is the whole point of the trust ladder: a later human read
    // outranks the older machine attestation.
    const report = auditBundle(
      bundle([
        concept("g/a.md", {
          ...attested("2026-01-01T00:00:00Z"),
          verified: [{ by: "human:jcsoftdev", at: "2026-07-01T00:00:00Z" }],
        }),
      ]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
  });

  it("flags uncommitted work regardless of dates", () => {
    // The commit clock cannot see edits that are not committed yet, so a dirty
    // path is stale by definition — its last commit date is about older code.
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2030-01-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-01-01T00:00:00Z", uncommitted: true } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].reason).toBe("uncommitted");
  });

  it("reports a never-attested concept separately instead of guessing it is stale", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts" })]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
    expect(report.unattested).toEqual(["g/a.md"]);
  });

  it("does not call staleness on an anchor that is already broken", () => {
    // A missing file has no meaningful commit date; reporting it as stale too
    // would double-count one problem and hide which fix is needed.
    const clock = clockOf({});
    const report = auditBundle(
      bundle([
        concept("g/a.md", { type: "Gotcha", resource: "../src/moved.ts", generated: { by: "h:x", at: "2026-01-01T00:00:00Z" } }),
      ]),
      LAYOUT,
      { graph: graphWithLoader(), clock, exists: onDisk("src/parser/wasm.ts") }
    );

    expect(report.stale).toEqual([]);
    expect(clock.seen).toEqual([]);
  });

  it("does not flag a concept committed in the same breath as the code it explains", () => {
    // The normal way knowledge gets written: note and code land together. The
    // declared timestamp is necessarily earlier than the commit that carries
    // both, so trusting it alone reports every fresh concept as stale.
    const sameCommit = { at: "2026-06-01T00:00:00Z", uncommitted: false };
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-05-30T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": sameCommit, "okf/g/a.md": sameCommit }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
  });

  it("still flags code that changed after the concept was last committed", () => {
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-01-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({
          "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false },
          "okf/g/a.md": { at: "2026-02-01T00:00:00Z", uncommitted: false },
        }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].attestedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("keeps the declared attestation as the baseline when it is the later of the two", () => {
    // A human who re-reads and re-attests without touching the file is still the
    // strongest signal there is; the file's commit date must not override it.
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-09-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({
          "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false },
          "okf/g/a.md": { at: "2026-02-01T00:00:00Z", uncommitted: false },
        }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
  });

  it("stays quiet while the concept itself is uncommitted", () => {
    // Author mid-edit: both sides are in flux and they are the one person who
    // already knows. Nagging here is noise during the exact work that fixes it.
    const report = auditBundle(
      bundle([concept("g/a.md", attested("2026-01-01T00:00:00Z"))]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({
          "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: true },
          "okf/g/a.md": { at: null, uncommitted: true },
        }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toEqual([]);
  });

  it("uses the concept's commit date even when it was never formally attested", () => {
    // A concept with no `generated` block is still dated by its own commit, so
    // drift in the code it explains is still detectable.
    const report = auditBundle(
      bundle([concept("g/a.md", { type: "Gotcha", resource: "../src/parser/wasm.ts" })]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({
          "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false },
          "okf/g/a.md": { at: "2026-02-01T00:00:00Z", uncommitted: false },
        }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale).toHaveLength(1);
    expect(report.unattested).toEqual(["g/a.md"]);
  });

  it("reports one concept once even when several of its anchors went stale", () => {
    const report = auditBundle(
      bundle([
        concept("g/a.md", {
          type: "Gotcha",
          resource: "../src/parser/wasm.ts",
          sources: [{ resource: "../src/parser/wasm.ts#loadGrammar" }],
          generated: { by: "human:jcsoftdev", at: "2026-01-01T00:00:00Z" },
        }),
      ]),
      LAYOUT,
      {
        graph: graphWithLoader(),
        clock: clockOf({ "src/parser/wasm.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
        exists: onDisk("src/parser/wasm.ts"),
      }
    );

    expect(report.stale.map((s) => s.concept)).toEqual(["g/a.md"]);
  });
});
