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
});
