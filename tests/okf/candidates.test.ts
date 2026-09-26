import { describe, it, expect } from "bun:test";
import {
  buildCoveredAnchors,
  isCovered,
  mineFixCommits,
  mineOkfCandidates,
  proposeAnchor,
  parseHunkHeaders,
  scoreCommit,
  type FixCommit,
} from "../../src/okf/candidates.js";
import type { SymbolTable } from "../../src/okf/audit.js";
import type { RankedSymbol } from "../../src/graph/store.js";
import type { Bundle } from "../../src/okf/bundle.js";
import type { TypesafeFetchFn } from "../../src/typesafe/client.js";

// --- mineFixCommits -------------------------------------------------------

const SEP = "\x01";

function fakeSpawn(byArgs: (args: string[]) => { stdout: string; status: number }) {
  return (_cmd: string, args: string[]) => {
    const { stdout, status } = byArgs(args);
    return { stdout, stderr: "", status, signal: null, output: [], pid: 0 } as any;
  };
}

function metaRecord(hash: string, subject: string, body: string): string {
  return `${hash}${SEP}${subject}${SEP}${body}`;
}

/**
 * Builds `git log -z --numstat --pretty=format:%H` output for several commits.
 * `-z` NUL-terminates every token AND separately marks the record boundary
 * (see src/okf/candidates.ts's parseNumstat doc), so each record already ends
 * with one NUL and consecutive records need one MORE between them.
 */
function numstatOutput(records: { hash: string; files: { path: string; added: number; deleted: number }[] }[]): string {
  return records
    .map((r) => `${r.hash}\n${r.files.map((f) => `${f.added}\t${f.deleted}\t${f.path}`).join("\0")}\0`)
    .join("\0");
}

describe("mineFixCommits", () => {
  it("keeps only conventional fix: commits, with body and per-file changed lines", () => {
    const metaOut =
      [
        metaRecord("h1", "fix: null check in parser", "The symptom was elsewhere."),
        metaRecord("h2", "feat: add candidates command", ""),
        metaRecord("h3", "fix(okf): resolve anchor before writing", "Body two."),
      ].join("\0") + "\0";
    const numstatOut = numstatOutput([
      { hash: "h1", files: [{ path: "src/parser/wasm.ts", added: 5, deleted: 1 }] },
      { hash: "h2", files: [{ path: "src/okf/candidates.ts", added: 50, deleted: 0 }] },
      {
        hash: "h3",
        files: [
          { path: "src/okf/audit.ts", added: 3, deleted: 2 },
          { path: "package-lock.json", added: 100, deleted: 100 },
        ],
      },
    ]);

    const spawn = fakeSpawn((args) =>
      args.includes("--numstat") ? { stdout: numstatOut, status: 0 } : { stdout: metaOut, status: 0 }
    );

    const commits = mineFixCommits({ cwd: "/repo", spawn: spawn as any });

    expect(commits.map((c) => c.hash)).toEqual(["h1", "h3"]);
    expect(commits[0]!.subject).toBe("fix: null check in parser");
    expect(commits[0]!.body).toBe("The symptom was elsewhere.");
    expect(commits[0]!.changes).toEqual([{ path: "src/parser/wasm.ts", lines: 6 }]);
    // package-lock.json rides along in numstat but is not itself excluded by
    // mining — proposeAnchor is what filters noise paths out of anchor choice.
    expect(commits[1]!.changes.map((c) => c.path)).toContain("package-lock.json");
  });

  it("passes --since as a rev range when it does not parse as a date", () => {
    let seenArgs: string[] = [];
    const spawn = fakeSpawn((args) => {
      seenArgs = args;
      return { stdout: "", status: 0 };
    });
    mineFixCommits({ cwd: "/repo", spawn: spawn as any, since: "a1f1dee" });
    expect(seenArgs.some((a) => a === "a1f1dee..HEAD")).toBe(true);
  });

  it("passes --since as --since=<date> when it parses as a date", () => {
    let seenArgs: string[] = [];
    const spawn = fakeSpawn((args) => {
      seenArgs = args;
      return { stdout: "", status: 0 };
    });
    mineFixCommits({ cwd: "/repo", spawn: spawn as any, since: "2026-01-01" });
    expect(seenArgs.some((a) => a === "--since=2026-01-01")).toBe(true);
  });

  it("caps commits scanned with limit", () => {
    let seenArgs: string[] = [];
    const spawn = fakeSpawn((args) => {
      seenArgs = args;
      return { stdout: "", status: 0 };
    });
    mineFixCommits({ cwd: "/repo", spawn: spawn as any, limit: 50 });
    expect(seenArgs).toContain("-50");
  });
});

// --- proposeAnchor ---------------------------------------------------------

function symbol(name: string, file: string, start = 1, end = 10): RankedSymbol {
  return { id: 1, name, kind: "function", signature: "", file, start_line: start, end_line: end, rank: 1 };
}

function table(byFile: Record<string, RankedSymbol[]>): SymbolTable {
  const map = new Map(Object.entries(byFile));
  return { ranked: [...map.values()].flat(), byFile: map };
}

function commit(changes: { path: string; lines: number }[]): FixCommit {
  return { hash: "h1", subject: "fix: x", body: "y", changes };
}

describe("proposeAnchor", () => {
  it("anchors the most-changed non-noise file, at its top-ranked symbol", () => {
    const anchor = proposeAnchor(
      commit([
        { path: "src/a.ts", lines: 3 },
        { path: "src/b.ts", lines: 40 },
        { path: "package-lock.json", lines: 500 },
      ]),
      table({ "src/b.ts": [symbol("beta", "src/b.ts")] }),
      () => true
    );
    expect(anchor.path).toBe("src/b.ts");
    expect(anchor.symbol).toBe("beta");
    expect(anchor.proposed).toBe("src/b.ts#beta");
    expect(anchor.resolved).toBe(true);
  });

  it("prefers the most-changed source file over a larger test change", () => {
    const anchor = proposeAnchor(
      commit([
        { path: "src/serve.ts", lines: 12 },
        { path: "tests/integration/serve-lifecycle.test.ts", lines: 90 },
        { path: "tests/fakes/client.fake.ts", lines: 60 },
      ]),
      table({ "src/serve.ts": [symbol("watchClient", "src/serve.ts")] }),
      () => true
    );
    expect(anchor.proposed).toBe("src/serve.ts#watchClient");
  });

  it("anchors the symbol the diff's hunks sit in, not the file's top-ranked one", () => {
    const anchor = proposeAnchor(
      commit([{ path: "src/cli.ts", lines: 20 }]),
      table({ "src/cli.ts": [symbol("printHelp", "src/cli.ts"), symbol("watchParent", "src/cli.ts")] }),
      () => true,
      () => ["function watchParent(pid: number) {", "export function watchParent(pid: number) {", "const HELP = `"]
    );
    expect(anchor.proposed).toBe("src/cli.ts#watchParent");
  });

  it("matches hunk headers on whole identifiers only", () => {
    const anchor = proposeAnchor(
      commit([{ path: "src/a.ts", lines: 5 }]),
      table({ "src/a.ts": [symbol("run", "src/a.ts"), symbol("runSync", "src/a.ts")] }),
      () => true,
      () => ["export async function runSync(args: string[]) {"]
    );
    expect(anchor.symbol).toBe("runSync");
  });

  it("keeps the top-ranked symbol when no hunk header names a symbol", () => {
    const anchor = proposeAnchor(
      commit([{ path: "src/a.ts", lines: 5 }]),
      table({ "src/a.ts": [symbol("alpha", "src/a.ts"), symbol("beta", "src/a.ts")] }),
      () => true,
      () => ["", "import { x } from './x';"]
    );
    expect(anchor.symbol).toBe("alpha");
  });

  it("still anchors a test file when the commit touched nothing else", () => {
    const anchor = proposeAnchor(commit([{ path: "tests/a.test.ts", lines: 5 }]), table({}), () => true);
    expect(anchor.proposed).toBe("tests/a.test.ts");
  });

  it("falls back to a whole-file anchor when the file has no parsed symbols", () => {
    const anchor = proposeAnchor(commit([{ path: "src/unparsed.md", lines: 10 }]), table({}), () => true);
    expect(anchor.symbol).toBeNull();
    expect(anchor.proposed).toBe("src/unparsed.md");
    expect(anchor.resolved).toBe(true);
  });

  it("marks the anchor unresolved when the file no longer exists on disk", () => {
    const anchor = proposeAnchor(commit([{ path: "src/gone.ts", lines: 10 }]), table({}), () => false);
    expect(anchor.resolved).toBe(false);
  });
});

describe("parseHunkHeaders", () => {
  it("returns the function context git prints after each hunk range", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@ export function watchParent(pid: number) {",
      "+  check();",
      "@@ -40 +41 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(parseHunkHeaders(diff)).toEqual(["export function watchParent(pid: number) {", ""]);
  });
});

// --- coverage skip -----------------------------------------------------

describe("buildCoveredAnchors / isCovered", () => {
  function bundleWith(resource: string): { bundle: Bundle; layout: { bundleRoot: string; repoRoot: string } } {
    const bundle: Bundle = {
      root: "/repo/okf",
      okfVersion: "0.2",
      files: [
        {
          path: "gotchas/a.md",
          kind: "concept",
          raw: "",
          document: { frontmatter: { type: "Gotcha", resource }, body: "" },
        },
      ],
      issues: [],
    };
    return { bundle, layout: { bundleRoot: "/repo/okf", repoRoot: "/repo" } };
  }

  it("treats a whole-file anchor as covering every symbol in that file", () => {
    const { bundle, layout } = bundleWith("../src/a.ts");
    const covered = buildCoveredAnchors(bundle, layout);
    expect(isCovered(covered, "src/a.ts", "anything")).toBe(true);
  });

  it("only covers the exact symbol for a symbol-level anchor", () => {
    const { bundle, layout } = bundleWith("../src/a.ts#alpha");
    const covered = buildCoveredAnchors(bundle, layout);
    expect(isCovered(covered, "src/a.ts", "alpha")).toBe(true);
    expect(isCovered(covered, "src/a.ts", "beta")).toBe(false);
  });
});

// --- scoreCommit ------------------------------------------------------

function fakeFetch(handler: (init: RequestInit) => Response): TypesafeFetchFn {
  return async (_url, init) => handler(init);
}

describe("scoreCommit", () => {
  it("fans out all four questions in one call and normalizes the worthiness score", async () => {
    let capturedBody: any = null;
    const fetchFn = fakeFetch((init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          answers: {
            surprising: { type: "noul", noul: 0.8 },
            constraint: { type: "noul", noul: 0.3 },
            rejectedAlternative: { type: "noul", noul: 0.5 },
            worthiness: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 0.9, "3": 0.1 } },
          },
        }),
        { status: 200 }
      );
    });

    const score = await scoreCommit(
      { subject: "fix: x", body: "y", files: ["src/a.ts"] },
      "tok",
      { fetchFn }
    );

    expect(Object.keys(capturedBody.questions)).toEqual(
      expect.arrayContaining(["surprising", "constraint", "rejectedAlternative", "worthiness"])
    );
    expect(score.surprising).toBe(0.8);
    expect(score.constraint).toBe(0.3);
    expect(score.rejectedAlternative).toBe(0.5);
    // score=2 of criteria length 4 (indices 0..3) -> 2/3
    expect(score.worthiness).toBeCloseTo(2 / 3);
  });

  it("returns all-null scores, never throws, when Jev fails", async () => {
    const score = await scoreCommit(
      { subject: "fix: x", body: "y", files: [] },
      "tok",
      { fetchFn: fakeFetch(() => new Response("nope", { status: 500 })) }
    );
    expect(score).toEqual({ surprising: null, constraint: null, rejectedAlternative: null, worthiness: null });
  });
});

// --- mineOkfCandidates (orchestration) ---------------------------------

describe("mineOkfCandidates", () => {
  const emptyGraph = { pageRank: () => [], findCallers: () => [], impact: () => [] };

  function gitFixtures() {
    const metaOut =
      [metaRecord("h1", "fix: short", "s"), metaRecord("h2", "fix: much longer commit body describing a real fix", "much more text describing the incident in detail")].join(
        "\0"
      ) + "\0";
    const numstatOut = numstatOutput([
      { hash: "h1", files: [{ path: "src/a.ts", added: 1, deleted: 0 }] },
      {
        hash: "h2",
        files: [
          { path: "src/b.ts", added: 20, deleted: 5 },
          { path: "src/c.ts", added: 10, deleted: 0 },
        ],
      },
    ]);
    return fakeSpawn((args) => (args.includes("--numstat") ? { stdout: numstatOut, status: 0 } : { stdout: metaOut, status: 0 }));
  }

  it("falls back to heuristic ranking with a notice when no token is configured", async () => {
    const result = await mineOkfCandidates({
      cwd: "/repo",
      spawn: gitFixtures() as any,
      graph: emptyGraph,
      token: null,
      fsExists: () => true,
    });

    expect(result.heuristic).toBe(true);
    expect(result.notice).toBeTruthy();
    expect(result.candidates.length).toBe(2);
    expect(result.candidates.every((c) => c.scores === null)).toBe(true);
    // h2 touches more files and has a longer body -> ranks first heuristically.
    expect(result.candidates[0]!.hash).toBe("h2");
  });

  it("scores every remaining candidate with Jev and ranks by the combined score", async () => {
    const fetchFn = fakeFetch((init) => {
      const body = JSON.parse(init.body as string);
      const isH1 = body.state.subject === "fix: short";
      const noul = isH1 ? 0.1 : 0.9;
      return new Response(
        JSON.stringify({
          answers: {
            surprising: { type: "noul", noul },
            constraint: { type: "noul", noul },
            rejectedAlternative: { type: "noul", noul },
            worthiness: { type: "score", score: isH1 ? 0 : 3, confidence: 0.9, probabilities: {} },
          },
        })
      );
    });

    const result = await mineOkfCandidates({
      cwd: "/repo",
      spawn: gitFixtures() as any,
      graph: emptyGraph,
      token: "tok",
      fetchFn,
      fsExists: () => true,
    });

    expect(result.heuristic).toBe(false);
    expect(result.candidates[0]!.hash).toBe("h2");
    expect(result.candidates[0]!.scores?.surprising).toBe(0.9);
  });

  it("skips a commit whose proposed anchor is already covered by an existing concept", async () => {
    const bundle: Bundle = {
      root: "/repo/okf",
      okfVersion: "0.2",
      files: [
        { path: "gotchas/a.md", kind: "concept", raw: "", document: { frontmatter: { type: "Gotcha", resource: "../src/a.ts" }, body: "" } },
      ],
      issues: [],
    };

    const result = await mineOkfCandidates({
      cwd: "/repo",
      spawn: gitFixtures() as any,
      graph: emptyGraph,
      token: null,
      fsExists: () => true,
      bundle,
      bundleLayout: { bundleRoot: "/repo/okf", repoRoot: "/repo" },
    });

    expect(result.candidates.map((c) => c.hash)).not.toContain("h1");
    expect(result.candidates.map((c) => c.hash)).toContain("h2");
  });

  it("respects topN", async () => {
    const result = await mineOkfCandidates({
      cwd: "/repo",
      spawn: gitFixtures() as any,
      graph: emptyGraph,
      token: null,
      fsExists: () => true,
      topN: 1,
    });
    expect(result.candidates).toHaveLength(1);
  });
});
