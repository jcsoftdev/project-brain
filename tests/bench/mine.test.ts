import { describe, it, expect } from "bun:test";
import {
  isNoiseSubject,
  isNoisePath,
  mineQueries,
  formatQueriesJsonl,
  type SpawnFn,
  type MineStats,
} from "../../src/bench/mine.js";

describe("isNoiseSubject", () => {
  it("flags a release commit", () => {
    expect(isNoiseSubject("chore(release): 0.32.1")).toBe(true);
  });

  it("flags a bare version-bump subject", () => {
    expect(isNoiseSubject("0.32.1")).toBe(true);
    expect(isNoiseSubject("v0.32.1")).toBe(true);
  });

  it("flags a bump-version subject", () => {
    expect(isNoiseSubject("bump version to 1.2.3")).toBe(true);
  });

  it("does not flag an ordinary conventional-commit subject", () => {
    expect(isNoiseSubject("feat(okf): judge stale concepts with Claude")).toBe(false);
  });
});

describe("isNoisePath", () => {
  it("flags known lockfiles regardless of directory", () => {
    expect(isNoisePath("bun.lock")).toBe(true);
    expect(isNoisePath("frontend/package-lock.json")).toBe(true);
  });

  it("flags package.json and CHANGELOG", () => {
    expect(isNoisePath("package.json")).toBe(true);
    expect(isNoisePath("CHANGELOG.md")).toBe(true);
  });

  it("does not flag a source file", () => {
    expect(isNoisePath("src/commands/bench.ts")).toBe(false);
  });
});

// --- fake `git log` / `git blame` -------------------------------------------------

interface FakeFile {
  path: string;
  added: number;
}

interface FakeCommit {
  hash: string;
  subject: string;
  body: string;
  files: FakeFile[];
}

const RS = "\x01";

function metaChunk(c: FakeCommit): string {
  return `${c.hash}${RS}${c.subject}${RS}${c.body}`;
}

function numstatChunk(c: FakeCommit): string {
  return `${c.hash}\n${c.files.map((f) => `${f.added}\t0\t${f.path}`).join("\0")}\0`;
}

/** Default blame fixture: every added line of every commit still survives at HEAD, unmodified. */
function fullSurvivalBlame(commits: FakeCommit[], file: string): string {
  const lines: string[] = [];
  for (const c of commits) {
    const f = c.files.find((f) => f.path === file);
    if (!f) continue;
    for (let i = 0; i < f.added; i++) lines.push(`${c.hash} ${i + 1} ${i + 1}`);
  }
  return lines.join("\n");
}

/** Build a fake spawnSync answering the three `git` shapes mine.ts issues: log meta, log --numstat, and blame. */
function fakeGit(commits: FakeCommit[], blame?: (file: string) => string): SpawnFn {
  return ((_cmd: string, args: readonly string[]) => {
    if (args.includes("blame")) {
      const file = args[args.length - 1] as string;
      const stdout = blame ? blame(file) : fullSurvivalBlame(commits, file);
      return { status: 0, stdout, stderr: "", pid: 0, output: [], signal: null } as any;
    }
    const stdout = args.includes("--numstat")
      ? commits.map(numstatChunk).join("\0")
      : commits.map(metaChunk).join("\0");
    return { status: 0, stdout, stderr: "", pid: 0, output: [], signal: null } as any;
  }) as SpawnFn;
}

// Hex-looking hashes: the real blame parser only recognizes a header line
// when the leading token is hex, so fixtures use valid hex (unlike an
// arbitrary label such as "commit1") to exercise the same regex production runs.
const H1 = "a1";
const H2 = "a2";

function commit(hash: string, subject: string, files: FakeFile[], body = ""): FakeCommit {
  return { hash, subject, body, files };
}

const alwaysIndexed = () => true;

describe("mineQueries", () => {
  it("mines one query per commit, subject as query, changed files as expect", () => {
    const commits = [commit(H1, "feat: add auth check", [{ path: "src/auth.ts", added: 3 }])];

    const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

    expect(result).toEqual([{ query: "feat: add auth check", expect: ["src/auth.ts"] }]);
  });

  it("appends a short first body paragraph to the query", () => {
    const commits = [
      commit(
        H1,
        "fix: null deref",
        [{ path: "src/store.ts", added: 1 }],
        "Guard the missing case before it reaches the store."
      ),
    ];

    const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

    expect(result[0]!.query).toBe(
      "fix: null deref Guard the missing case before it reaches the store."
    );
  });

  it("drops a body paragraph that is too long to be a useful query addition", () => {
    const longParagraph = "word ".repeat(80).trim();
    const commits = [commit(H1, "fix: something", [{ path: "src/x.ts", added: 1 }], longParagraph)];

    const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

    expect(result[0]!.query).toBe("fix: something");
  });

  it("skips release commits", () => {
    const commits = [commit(H1, "chore(release): 1.0.0", [{ path: "package.json", added: 1 }])];

    expect(mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed })).toEqual([]);
  });

  it("skips a commit whose changed files are only non-indexed-by-name noise", () => {
    const commits = [
      commit(H1, "chore: bump lockfile", [
        { path: "bun.lock", added: 1 },
        { path: "package.json", added: 1 },
      ]),
    ];

    expect(mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed })).toEqual([]);
  });

  it("keeps only the non-noise, indexed files as expect when the commit mixes them with noise", () => {
    const commits = [
      commit(H1, "feat: wire new command", [
        { path: "package.json", added: 1 },
        { path: "src/commands/foo.ts", added: 2 },
      ]),
    ];

    const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

    expect(result).toEqual([{ query: "feat: wire new command", expect: ["src/commands/foo.ts"] }]);
  });

  it("skips a commit touching more files than the max-files cap", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1 }));
    const commits = [commit(H1, "refactor: sweep", many)];

    expect(
      mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed, maxFiles: 8 })
    ).toEqual([]);
  });

  it("keeps a commit right at the max-files cap", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1 }));
    const commits = [commit(H1, "refactor: sweep", eight)];

    expect(
      mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed, maxFiles: 8 })
    ).toHaveLength(1);
  });

  it("produces results in stable git-log order across multiple commits", () => {
    const commits = [
      commit(H1, "feat: one", [{ path: "src/one.ts", added: 1 }]),
      commit(H2, "feat: two", [{ path: "src/two.ts", added: 1 }]),
    ];

    const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

    expect(result.map((r) => r.query)).toEqual(["feat: one", "feat: two"]);
  });

  it("passes -<limit> to git log when a limit is given", () => {
    let seenArgs: string[] = [];
    const spawn: SpawnFn = ((_cmd: string, args: readonly string[]) => {
      seenArgs = args as string[];
      return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null } as any;
    }) as SpawnFn;

    mineQueries({ spawn, isIndexed: alwaysIndexed, limit: 50 });

    expect(seenArgs).toContain("-50");
  });

  describe("index filter", () => {
    it("drops a gold file the project's index does not have", () => {
      const commits = [commit(H1, "feat: thing", [{ path: "src/unindexed.ts", added: 3 }])];

      const result = mineQueries({ spawn: fakeGit(commits), isIndexed: () => false });

      expect(result).toEqual([]);
    });

    it("keeps only the indexed files, dropping the rest", () => {
      const commits = [
        commit(H1, "feat: thing", [
          { path: "src/indexed.ts", added: 2 },
          { path: "src/unindexed.ts", added: 2 },
        ]),
      ];

      const result = mineQueries({
        spawn: fakeGit(commits),
        isIndexed: (p) => p === "src/indexed.ts",
      });

      expect(result).toEqual([{ query: "feat: thing", expect: ["src/indexed.ts"] }]);
    });
  });

  describe("survival filter", () => {
    it("keeps a gold file whose added lines still fully survive at HEAD", () => {
      const commits = [commit(H1, "feat: thing", [{ path: "src/x.ts", added: 4 }])];

      // default blame fixture = full survival
      const result = mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed });

      expect(result).toEqual([{ query: "feat: thing", expect: ["src/x.ts"] }]);
    });

    it("drops a gold file whose added lines were entirely superseded at HEAD", () => {
      const commits = [commit(H1, "feat: thing", [{ path: "src/x.ts", added: 4 }])];

      // blame attributes every surviving line to some OTHER commit — none of
      // this commit's 4 added lines are still there.
      const result = mineQueries({
        spawn: fakeGit(commits, () => "deadbeef 1 1\ndeadbeef 2 2"),
        isIndexed: alwaysIndexed,
      });

      expect(result).toEqual([]);
    });

    it("drops a file below the survival threshold and keeps one above it", () => {
      const commits = [
        commit(H1, "feat: two files", [
          { path: "src/mostly-gone.ts", added: 10 },
          { path: "src/mostly-intact.ts", added: 10 },
        ]),
      ];

      const result = mineQueries({
        spawn: fakeGit(commits, (file) => {
          if (file === "src/mostly-gone.ts") {
            // 2 of 10 added lines survive: 20%, below the 50% default.
            return `${H1} 1 1\n${H1} 2 2`;
          }
          // 9 of 10 survive: 90%, above threshold.
          return Array.from({ length: 9 }, (_, i) => `${H1} ${i + 1} ${i + 1}`).join("\n");
        }),
        isIndexed: alwaysIndexed,
      });

      expect(result).toEqual([{ query: "feat: two files", expect: ["src/mostly-intact.ts"] }]);
    });

    it("respects a custom --min-survival threshold", () => {
      const commits = [commit(H1, "feat: thing", [{ path: "src/x.ts", added: 10 }])];
      // 3 of 10 survive: 30%.
      const blame = () => Array.from({ length: 3 }, (_, i) => `${H1} ${i + 1} ${i + 1}`).join("\n");

      expect(
        mineQueries({ spawn: fakeGit(commits, blame), isIndexed: alwaysIndexed, minSurvival: 0.5 })
      ).toEqual([]);
      expect(
        mineQueries({ spawn: fakeGit(commits, blame), isIndexed: alwaysIndexed, minSurvival: 0.2 })
      ).toHaveLength(1);
    });

    it("treats a file no longer present at HEAD (blame fails) as fully lost", () => {
      const commits = [commit(H1, "feat: thing", [{ path: "src/deleted.ts", added: 5 }])];
      const spawn: SpawnFn = ((_cmd: string, args: readonly string[]) => {
        if (args.includes("blame")) {
          return { status: 128, stdout: "", stderr: "fatal: no such path", pid: 0, output: [], signal: null } as any;
        }
        const stdout = args.includes("--numstat")
          ? commits.map(numstatChunk).join("\0")
          : commits.map(metaChunk).join("\0");
        return { status: 0, stdout, stderr: "", pid: 0, output: [], signal: null } as any;
      }) as SpawnFn;

      expect(mineQueries({ spawn, isIndexed: alwaysIndexed })).toEqual([]);
    });

    it("caches blame per file across multiple commits touching the same file", () => {
      const commits = [
        commit(H1, "feat: one", [{ path: "src/shared.ts", added: 2 }]),
        commit(H2, "feat: two", [{ path: "src/shared.ts", added: 2 }]),
      ];
      let blameCalls = 0;
      const spawn: SpawnFn = ((_cmd: string, args: readonly string[]) => {
        if (args.includes("blame")) {
          blameCalls++;
          return { status: 0, stdout: fullSurvivalBlame(commits, "src/shared.ts"), stderr: "", pid: 0, output: [], signal: null } as any;
        }
        const stdout = args.includes("--numstat")
          ? commits.map(numstatChunk).join("\0")
          : commits.map(metaChunk).join("\0");
        return { status: 0, stdout, stderr: "", pid: 0, output: [], signal: null } as any;
      }) as SpawnFn;

      mineQueries({ spawn, isIndexed: alwaysIndexed });

      expect(blameCalls).toBe(1);
    });
  });

  describe("onStats", () => {
    it("reports the funnel count surviving each filter stage", () => {
      const commits = [
        commit(H1, "feat: kept", [{ path: "src/kept.ts", added: 2 }]),
        commit(H2, "chore(release): 1.0.0", [{ path: "package.json", added: 1 }]),
      ];
      let stats: MineStats | undefined;

      mineQueries({ spawn: fakeGit(commits), isIndexed: alwaysIndexed, onStats: (s) => (stats = s) });

      expect(stats).toEqual({
        scanned: 2,
        afterNoiseSubject: 1,
        afterFileCountBound: 1,
        afterNoisePath: 1,
        afterIndexFilter: 1,
        afterSurvivalFilter: 1,
      });
    });
  });
});

describe("formatQueriesJsonl", () => {
  it("serializes a single-file expect as a plain string for readability", () => {
    const out = formatQueriesJsonl([{ query: "q1", expect: ["a.ts"] }]);
    expect(out).toBe('{"query":"q1","expect":"a.ts"}\n');
  });

  it("serializes a multi-file expect as an array", () => {
    const out = formatQueriesJsonl([{ query: "q1", expect: ["a.ts", "b.ts"] }]);
    expect(out).toBe('{"query":"q1","expect":["a.ts","b.ts"]}\n');
  });

  it("joins multiple mined queries with newlines, one JSON object per line", () => {
    const out = formatQueriesJsonl([
      { query: "q1", expect: ["a.ts"] },
      { query: "q2", expect: ["b.ts"] },
    ]);
    expect(out).toBe('{"query":"q1","expect":"a.ts"}\n{"query":"q2","expect":"b.ts"}\n');
  });
});
