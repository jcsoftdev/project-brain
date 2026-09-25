import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitClock } from "../../src/git/last-changed.js";

const T1 = "2026-01-01T00:00:00+00:00";
const T2 = "2026-06-01T00:00:00+00:00";

describe("createGitClock", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-clock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function git(args: string[], date?: string): void {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  async function initRepo(): Promise<void> {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
  }

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(root, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const numbered = (count: number, marker = "x") =>
    Array.from({ length: count }, (_, i) => `line ${i + 1} ${marker}`).join("\n") + "\n";

  it("reports the commit date of the last change to a file", async () => {
    await initRepo();
    await write("src/a.ts", numbered(20));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);

    const change = createGitClock(root).lastChanged("src/a.ts");

    expect(change.at).not.toBeNull();
    expect(new Date(change.at!).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(change.uncommitted).toBe(false);
  });

  it("ignores a change outside the cited line range", async () => {
    // The whole point of range precision: editing an unrelated part of a large
    // file must not mark every concept that cites the file as stale.
    await initRepo();
    await write("src/a.ts", numbered(20));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);

    const edited = numbered(20).split("\n");
    edited[1] = "line 2 EDITED";
    await write("src/a.ts", edited.join("\n"));
    git(["add", "-A"]);
    git(["commit", "-qm", "two"], T2);

    const clock = createGitClock(root);

    expect(new Date(clock.lastChanged("src/a.ts", { start: 15, end: 20 }).at!).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(new Date(clock.lastChanged("src/a.ts", { start: 1, end: 5 }).at!).toISOString()).toBe(
      "2026-06-01T00:00:00.000Z"
    );
  });

  it("falls back to the whole file when the range is past the end of it", async () => {
    // git errors on an out-of-bounds -L range. A concept citing lines that no
    // longer exist is exactly the case staleness should catch, so degrading to
    // the file's own date beats reporting "unknown".
    await initRepo();
    await write("src/a.ts", numbered(5));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);

    const change = createGitClock(root).lastChanged("src/a.ts", { start: 900, end: 999 });

    expect(new Date(change.at!).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("flags a path with uncommitted changes", async () => {
    await initRepo();
    await write("src/a.ts", numbered(5));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);
    await write("src/a.ts", numbered(5, "MODIFIED"));

    expect(createGitClock(root).lastChanged("src/a.ts").uncommitted).toBe(true);
  });

  it("flags an untracked file as uncommitted rather than unknown", async () => {
    await initRepo();
    await write("src/a.ts", numbered(5));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);
    await write("src/new.ts", numbered(5));

    const change = createGitClock(root).lastChanged("src/new.ts");

    expect(change.at).toBeNull();
    expect(change.uncommitted).toBe(true);
  });

  it("reports a path git knows nothing about as unknown, not as changed", async () => {
    await initRepo();
    await write("src/a.ts", numbered(5));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);

    const change = createGitClock(root).lastChanged("src/gone.ts");

    expect(change).toEqual({ at: null, uncommitted: false });
  });

  it("degrades to unknown outside a git repository instead of throwing", async () => {
    await write("src/a.ts", numbered(5));

    expect(createGitClock(root).lastChanged("src/a.ts")).toEqual({ at: null, uncommitted: false });
  });

  it("reads the working tree once, not once per anchor", async () => {
    // A bundle cites the same handful of files repeatedly; re-running
    // `git status` for each anchor turns an audit into dozens of subprocesses.
    await initRepo();
    await write("src/a.ts", numbered(5));
    git(["add", "-A"]);
    git(["commit", "-qm", "one"], T1);
    await write("src/a.ts", numbered(5, "MODIFIED"));

    const clock = createGitClock(root);
    clock.lastChanged("src/a.ts");
    await write("src/a.ts", numbered(5));

    // Restoring the file after the first call must NOT change the answer:
    // the dirty set was captured up front and is reused.
    expect(clock.lastChanged("src/a.ts").uncommitted).toBe(true);
  });

  describe("range-scoped uncommitted", () => {
    it("flags a ranged anchor as uncommitted only when a dirty hunk overlaps it", async () => {
      // A large file with one unrelated edit must not mark every range-anchored
      // concept in it stale with "uncommitted".
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      const edited = numbered(20).split("\n");
      edited[1] = "line 2 EDITED";
      await write("src/a.ts", edited.join("\n"));

      const clock = createGitClock(root);

      expect(clock.lastChanged("src/a.ts", { start: 1, end: 5 }).uncommitted).toBe(true);
      expect(clock.lastChanged("src/a.ts", { start: 15, end: 20 }).uncommitted).toBe(false);
    });

    it("sees a staged change via the combined diff against HEAD", async () => {
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      const edited = numbered(20).split("\n");
      edited[1] = "line 2 EDITED";
      await write("src/a.ts", edited.join("\n"));
      git(["add", "-A"]);

      const change = createGitClock(root).lastChanged("src/a.ts", { start: 1, end: 5 });
      expect(change.uncommitted).toBe(true);
    });

    it("treats an untracked file as uncommitted for a ranged anchor too", async () => {
      // Untracked files have no HEAD blob to diff against, so hunks cannot be
      // computed — they keep whole-file behaviour.
      await initRepo();
      await write("src/a.ts", numbered(5));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);
      await write("src/new.ts", numbered(5));

      const change = createGitClock(root).lastChanged("src/new.ts", { start: 1, end: 2 });

      expect(change.uncommitted).toBe(true);
    });

    it("treats a renamed file as uncommitted for a ranged anchor too", async () => {
      await initRepo();
      await write("src/old.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);
      await rm(join(root, "src/old.ts"));
      await write("src/renamed.ts", numbered(20));
      git(["add", "-A"]);

      const change = createGitClock(root).lastChanged("src/renamed.ts", { start: 15, end: 20 });

      expect(change.uncommitted).toBe(true);
    });

    it("computes dirty hunks once per path, not once per anchor", async () => {
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      const edited = numbered(20).split("\n");
      edited[1] = "line 2 EDITED";
      await write("src/a.ts", edited.join("\n"));

      const clock = createGitClock(root);
      clock.lastChanged("src/a.ts", { start: 1, end: 5 });
      await write("src/a.ts", numbered(20));

      // Restoring the file after the first call must not change the answer:
      // the hunk list was captured on first use and is reused.
      expect(clock.lastChanged("src/a.ts", { start: 1, end: 5 }).uncommitted).toBe(true);
    });

    it("still reports whole-file uncommitted when no range is given", async () => {
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      const edited = numbered(20).split("\n");
      edited[1] = "line 2 EDITED";
      await write("src/a.ts", edited.join("\n"));

      expect(createGitClock(root).lastChanged("src/a.ts").uncommitted).toBe(true);
    });
  });

  describe("memoization by path + range", () => {
    it("invokes git once for two anchors with identical path and range", async () => {
      // findStale calls lastChanged() once per anchor, and a bundle routinely
      // cites the same symbol from more than one concept — without a cache
      // keyed on path+range, every repeat pays for its own subprocesses.
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      let calls = 0;
      const spawn = ((...args: Parameters<typeof spawnSync>) => {
        calls++;
        return spawnSync(...args);
      }) as typeof spawnSync;

      const clock = createGitClock(root, { spawn });
      clock.lastChanged("src/a.ts", { start: 1, end: 5 });
      const callsAfterFirst = calls;
      const second = clock.lastChanged("src/a.ts", { start: 1, end: 5 });

      expect(calls).toBe(callsAfterFirst);
      expect(second.at).not.toBeNull();
    });

    it("still invokes git for a different range on the same path", async () => {
      await initRepo();
      await write("src/a.ts", numbered(20));
      git(["add", "-A"]);
      git(["commit", "-qm", "one"], T1);

      let calls = 0;
      const spawn = ((...args: Parameters<typeof spawnSync>) => {
        calls++;
        return spawnSync(...args);
      }) as typeof spawnSync;

      const clock = createGitClock(root, { spawn });
      clock.lastChanged("src/a.ts", { start: 1, end: 5 });
      const callsAfterFirst = calls;
      clock.lastChanged("src/a.ts", { start: 10, end: 15 });

      expect(calls).toBeGreaterThan(callsAfterFirst);
    });
  });
});
