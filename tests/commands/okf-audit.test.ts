import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import { runOkfAudit } from "../../src/commands/okf.js";
import type { CodeChange, CodeClock } from "../../src/git/last-changed.js";
import type { StaleJudge } from "../../src/okf/judge.js";

const silentClock: CodeClock = { lastChanged: () => ({ at: null, uncommitted: false }) };

function clockOf(answers: Record<string, CodeChange>): CodeClock {
  return { lastChanged: (path) => answers[path] ?? { at: null, uncommitted: false } };
}

/** alpha (a.ts) calls beta (b.ts); gamma (c.ts) is unexplained. */
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
  ]);
  store.replaceFile("src/b.ts", "typescript", "h", 0, [
    { name: "beta", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.replaceFile("src/c.ts", "typescript", "h", 0, [
    { name: "gamma", kind: "function", signature: "", start_line: 1, end_line: 5, edges: [] },
  ]);
  store.resolveEdgesForFiles(["src/a.ts", "src/b.ts", "src/c.ts"]);
  return store;
}

describe("runOkfAudit", () => {
  let root: string;
  let bundleDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-audit-"));
    bundleDir = join(root, "okf");
    await mkdir(bundleDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(bundleDir, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const doc = (frontmatter: string[], body = "Because."): string =>
    ["---", ...frontmatter, "---", "", "# Why", body].join("\n");

  const deps = (overrides: Partial<Parameters<typeof runOkfAudit>[1]> = {}) => ({
    graph: chainGraph(),
    clock: silentClock,
    exists: () => true,
    repoRoot: root,
    ...overrides,
  });

  it("passes a bundle whose anchors all resolve and whose knowledge is current", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 anchor");
  });

  it("reports a broken anchor and fails the run", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/moved.ts"]));

    const result = await runOkfAudit(bundleDir, deps({ exists: (p: string) => p !== "src/moved.ts" }));

    expect(result.ok).toBe(false);
    expect(result.output).toContain("d/a.md");
    expect(result.output).toContain("../src/moved.ts");
    expect(result.output).toContain("file not found");
  });

  it("reports a stale concept with both dates so the author can judge it", async () => {
    await write(
      "d/a.md",
      doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }'])
    );

    const result = await runOkfAudit(
      bundleDir,
      deps({ clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }) })
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("2026-06-01T00:00:00Z");
    expect(result.output).toContain("2026-01-01T00:00:00Z");
  });

  it("lists the highest-ranked code nothing explains without failing the run", async () => {
    // A documentation backlog is a suggestion, not a defect. Failing on it would
    // make the audit unusable in CI from the very first commit.
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("gamma");
  });

  it("suggests a link between concepts whose code calls across them", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));
    await write("d/b.md", doc(["type: Decision", "resource: ../src/b.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("d/a.md");
    expect(result.output).toContain("d/b.md");
    expect(result.output).toContain("alpha");
  });

  it("names the concepts to re-read when asked about a changed symbol", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps({ symbol: "beta" }));

    expect(result.output).toContain("beta");
    expect(result.output).toContain("d/a.md");
  });

  it("says so plainly when a changed symbol has no knowledge attached to it", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps({ symbol: "gamma" }));

    expect(result.ok).toBe(true);
    expect(result.output).toContain("no concept");
  });

  it("flags a concept that anchors code but was never attested", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts"]));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.output).toContain("never attested");
    expect(result.output).toContain("d/a.md");
  });

  it("reports a missing bundle directory as a message rather than a crash", async () => {
    const result = await runOkfAudit(join(root, "absent"), deps());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not exist");
  });

  it("hints at the closest symbol name for a likely rename", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts#alph"]));

    const result = await runOkfAudit(bundleDir, deps());

    expect(result.output).toContain("did you mean");
    expect(result.output).toContain("alpha");
  });

  it("prints one JSON object instead of prose when --json is set", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const result = await runOkfAudit(bundleDir, deps({ json: true }));

    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(parsed.broken).toEqual([]);
    expect(Array.isArray(parsed.coverage)).toBe(true);
    expect(Array.isArray(parsed.ambiguous)).toBe(true);
  });

  it("keeps the exit code the same in --json mode", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/moved.ts"]));

    const result = await runOkfAudit(
      bundleDir,
      deps({ json: true, exists: (p: string) => p !== "src/moved.ts" })
    );

    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
  });

  it("includes a rename hint in the JSON broken-anchor entry", async () => {
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts#alph"]));

    const result = await runOkfAudit(bundleDir, deps({ json: true }));

    const parsed = JSON.parse(result.output);
    expect(parsed.broken).toHaveLength(1);
    expect(parsed.broken[0].hint).toBe("alpha");
  });

  it("computes the symbol table once when --symbol is given, not once per pass", async () => {
    // auditBundle() and impactedConcepts() each used to call readSymbols(),
    // which runs a full graph.pageRank() — doubling the cost of every
    // --symbol audit for no reason, since both passes want the same table.
    await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']));

    const real = chainGraph();
    let pageRankCalls = 0;
    const spyGraph = {
      pageRank: (...args: Parameters<GraphStore["pageRank"]>) => {
        pageRankCalls++;
        return real.pageRank(...args);
      },
      findCallers: (...args: Parameters<GraphStore["findCallers"]>) => real.findCallers(...args),
      impact: (...args: Parameters<GraphStore["impact"]>) => real.impact(...args),
    };

    await runOkfAudit(bundleDir, deps({ graph: spyGraph, symbol: "beta" }));

    expect(pageRankCalls).toBe(1);
  });

  describe("--judge", () => {
    const staleDoc = doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']);

    const fakeJudge = (verdict: "holds" | "outdated" | "unclear", reason = "because"): StaleJudge => ({
      judge: async () => ({ verdict, reason }),
    });

    const withJudge = (judge: StaleJudge) => ({
      judge,
      diff: () => "some diff",
    });

    it("moves a holds verdict out of stale, into a judged backlog that does not fail the run", async () => {
      await write("d/a.md", staleDoc);

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: withJudge(fakeJudge("holds", "still true")),
        })
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain("judged");
      expect(result.output).toContain("still true");
    });

    it("keeps an outdated verdict failing the run, annotated with the reason", async () => {
      await write("d/a.md", staleDoc);

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: withJudge(fakeJudge("outdated", "contradicted by the diff")),
        })
      );

      expect(result.ok).toBe(false);
      expect(result.output).toContain("contradicted by the diff");
    });

    it("carries verdicts in --json output too", async () => {
      await write("d/a.md", staleDoc);

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: withJudge(fakeJudge("holds", "still true")),
          json: true,
        })
      );

      const parsed = JSON.parse(result.output);
      expect(parsed.stale).toEqual([]);
      expect(parsed.judged).toHaveLength(1);
      expect(parsed.judged[0].judge).toEqual({ verdict: "holds", reason: "still true" });
    });

    it("never judges an unattested or uncommitted finding, only code-changed", async () => {
      let judgeCalls = 0;
      await write("d/a.md", doc(["type: Decision", "resource: ../src/a.ts"])); // never attested

      await runOkfAudit(
        bundleDir,
        deps({
          judge: withJudge({
            judge: async () => {
              judgeCalls++;
              return { verdict: "holds", reason: "x" };
            },
          }),
        })
      );

      expect(judgeCalls).toBe(0);
    });

    it("aborts judging and falls back to the unjudged report on AuthenticationError", async () => {
      await write("d/a.md", staleDoc);
      const authError = new Anthropic.AuthenticationError(401, {}, "bad credentials", new Headers());

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: withJudge({
            judge: async () => {
              throw authError;
            },
          }),
        })
      );

      // Falls back to the plain, unjudged audit rather than throwing out of runOkfAudit.
      expect(result.ok).toBe(false);
      expect(result.output).toContain("d/a.md");
    });
  });

  describe("--judge-compare", () => {
    const staleDoc = doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']);

    const fakeJudge = (verdict: "holds" | "outdated" | "unclear", reason = "because"): StaleJudge => ({
      judge: async () => ({ verdict, reason }),
    });

    it("prints an agreement report comparing the primary and compare judges, without changing ok/stale", async () => {
      await write("d/a.md", staleDoc);

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: { judge: fakeJudge("outdated"), diff: () => "some diff", compare: fakeJudge("unclear") },
        })
      );

      expect(result.ok).toBe(false);
      expect(result.output).toContain("agreement");
      expect(result.output).toContain("0/1");
      expect(result.output).toContain("outdated");
      expect(result.output).toContain("unclear");
    });

    it("carries the comparison in --json output too", async () => {
      await write("d/a.md", staleDoc);

      const result = await runOkfAudit(
        bundleDir,
        deps({
          clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
          judge: { judge: fakeJudge("holds"), diff: () => "some diff", compare: fakeJudge("holds") },
          json: true,
        })
      );

      const parsed = JSON.parse(result.output);
      expect(parsed.compare).toHaveLength(1);
      expect(parsed.compare[0].agree).toBe(true);
    });
  });

  describe("judge progress line", () => {
    const staleDoc = doc(["type: Decision", "resource: ../src/a.ts", 'generated: { by: "human:x", at: 2026-01-01T00:00:00Z }']);

    const fakeJudge = (verdict: "holds" | "outdated" | "unclear", reason = "because"): StaleJudge => ({
      judge: async () => ({ verdict, reason }),
    });

    it("names the default (claude) model when no modelName override is given", async () => {
      await write("d/a.md", staleDoc);
      const logSpy = spyOn(console, "log");
      try {
        await runOkfAudit(
          bundleDir,
          deps({
            clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
            judge: { judge: fakeJudge("holds"), diff: () => "some diff" },
          })
        );
        const progressLine = logSpy.mock.calls.map((c) => c[0]).find((line) => String(line).includes("judging"));
        expect(progressLine).toContain("claude-opus-5");
      } finally {
        logSpy.mockRestore();
      }
    });

    // T5 small fix: --judge-model jev must name the judge actually used, not
    // the hardcoded default — the progress line lied about which model ran.
    it("names the actual judge (e.g. jev-latest) when modelName overrides the default", async () => {
      await write("d/a.md", staleDoc);
      const logSpy = spyOn(console, "log");
      try {
        await runOkfAudit(
          bundleDir,
          deps({
            clock: clockOf({ "src/a.ts": { at: "2026-06-01T00:00:00Z", uncommitted: false } }),
            judge: { judge: fakeJudge("holds"), diff: () => "some diff", modelName: "jev-latest" },
          })
        );
        const progressLine = logSpy.mock.calls.map((c) => c[0]).find((line) => String(line).includes("judging"));
        expect(progressLine).toContain("jev-latest");
        expect(progressLine).not.toContain("claude-opus-5");
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
