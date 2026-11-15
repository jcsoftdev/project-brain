import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { defaultStatusDeps, execute, type StatusDeps, type StatusReport } from "../../src/commands/status.js";
import { PROJECTS_FILE } from "../../src/store/project-registry.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function commit(cwd: string, file: string): Promise<void> {
  await writeFile(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", file);
}

let base: string;
let dataDir: string;
/** Pending: ahead of upstream, an unpushed branch, a merged worktree, an unmerged one, a dirty file. */
let busy: string;
/** Cloned and pushed, nothing left. */
let tidy: string;

beforeAll(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), "brain-status-")));
  dataDir = join(base, "data");
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  git(base, "init", "-q", "-b", "main", seed);
  await commit(seed, "a.txt");
  git(seed, "push", "-q", remote, "main");

  busy = join(base, "busy");
  tidy = join(base, "tidy");
  git(base, "clone", "-q", remote, busy);
  git(base, "clone", "-q", remote, tidy);

  await commit(busy, "ahead.txt");
  await writeFile(join(busy, ".git", "info", "exclude"), ".claude/worktrees/\n");

  git(busy, "checkout", "-q", "-b", "feat/local");
  await commit(busy, "local.txt");
  git(busy, "checkout", "-q", "main");

  const done = join(busy, ".claude", "worktrees", "done");
  git(busy, "worktree", "add", "-q", "-b", "worktree/done", done);
  await commit(done, "done.txt");
  git(busy, "merge", "-q", "--no-ff", "-m", "merge done", "worktree/done");

  const open = join(busy, ".claude", "worktrees", "open");
  git(busy, "worktree", "add", "-q", "-b", "worktree/open", open);
  await commit(open, "open.txt");

  await writeFile(join(busy, "untracked.txt"), "x");

  await mkdir(dataDir, { recursive: true });
  const entry = (root: string) => ({ root, updatedAt: 1 });
  await writeFile(
    join(dataDir, PROJECTS_FILE),
    JSON.stringify({ busy: entry(busy), tidy: entry(tidy), gone: entry(join(base, "missing")), "busy@open": entry(open) })
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    ...defaultStatusDeps(),
    dataDir,
    installedVersion: "1.0.0",
    cwd: base,
    distTags: async () => ({ latest: "1.0.0", next: "1.0.0" }),
    pendingUnits: async () => ({ pending: [], skipped: [] }),
    holders: async () => () => [],
    ...overrides,
  };
}

async function run(args: string[], d: StatusDeps): Promise<{ out: string; exitCode: number | undefined }> {
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
  const before = process.exitCode;
  // Bun keeps a previous 0 when undefined is assigned, so start every run from 0 (success).
  process.exitCode = 0;
  try {
    await execute(args, d);
    return { out: logged.join("\n"), exitCode: process.exitCode as number | undefined };
  } finally {
    process.exitCode = before;
    log.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("project-brain status", () => {
  it("reports every pending git fact for a project, with the command that resolves it", async () => {
    const { out } = await run(["--json"], deps());
    const report = JSON.parse(out) as StatusReport;

    expect(report.projects.map((p) => p.id)).toEqual(["busy", "tidy"]);
    const [p, t] = report.projects;
    expect(t!.clean).toBe(true);
    expect(p!.clean).toBe(false);

    expect(p!.unpushed).toEqual([
      { branch: "main", ahead: 3, upstream: "origin/main", command: `git -C ${busy} push origin main` },
      { branch: "feat/local", ahead: 1, upstream: null, command: `git -C ${busy} push -u origin feat/local` },
      { branch: "worktree/open", ahead: 1, upstream: null, command: `git -C ${busy} push -u origin worktree/open` },
    ]);
    expect(p!.dirty).toEqual({ count: 1, command: `git -C ${busy} status` });

    const done = join(busy, ".claude", "worktrees", "done");
    expect(p!.worktrees).toEqual({
      count: 2,
      removable: [{ path: done, branch: "worktree/done", command: `git -C ${busy} worktree remove ${done}` }],
    });
    expect(report.clean).toBe(false);
  });

  it("prints a grouped report that leaves clean projects out", async () => {
    const { out } = await run([], deps());
    expect(out).toContain(`busy  ${busy}`);
    expect(out).not.toContain("tidy");
    expect(out).toContain("main: 3 commits ahead of origin/main");
    expect(out).toContain(`$ git -C ${busy} push -u origin feat/local`);
    expect(out).toContain("2 total, 1 merged and safe to remove");
    expect(out).not.toContain("global");
  });

  it("never offers a worktree a process is still using", async () => {
    const { out } = await run(["--json"], deps({ holders: async () => () => [4242] }));
    expect((JSON.parse(out) as StatusReport).projects[0]!.worktrees.removable).toEqual([]);
  });

  it("prints one all-clear line when nothing is pending", async () => {
    const { out } = await run(["--project", "tidy"], deps());
    expect(out).toBe("All clear: 1 project checked, nothing pending.");
  });

  it("reports units not enabled and a latest tag that lags next", async () => {
    const { out } = await run(
      ["--project", "tidy"],
      deps({
        distTags: async () => ({ latest: "1.0.0", next: "1.1.0" }),
        pendingUnits: async () => ({ pending: [{ id: "skill:x", label: "X" }], skipped: [] }),
      })
    );
    expect(out).toContain("1 unit available but not enabled: skill:x");
    expect(out).toContain("$ project-brain setup");
    expect(out).toContain("latest 1.0.0 lags next 1.1.0");
    expect(out).toContain("$ npm dist-tag add project-brain@1.1.0 latest");
  });

  it("offers the update when the installed version is behind latest, and fails soft without npm", async () => {
    const behind = await run(["--project", "tidy"], deps({ distTags: async () => ({ latest: "1.2.0", next: "1.2.0" }) }));
    expect(behind.out).toContain("$ project-brain update");

    const offline = await run(["--project", "tidy", "--json"], deps({ distTags: async () => null, pendingUnits: async () => null }));
    const report = JSON.parse(offline.out) as StatusReport;
    expect(report.version).toMatchObject({ latest: null, updateAvailable: false, commands: [] });
    expect(report.units).toBeNull();
    expect(offline.exitCode).toBe(0);
  });

  it("rejects an unknown project id", async () => {
    const { out, exitCode } = await run(["--project", "nope"], deps());
    expect(out).toContain('unknown project "nope"');
    expect(exitCode).toBe(1);
  });

  it("changes nothing on disk", async () => {
    const before = git(busy, "status", "--porcelain");
    const worktrees = git(busy, "worktree", "list");
    const branches = git(busy, "branch", "--list");
    await run([], deps());
    expect(git(busy, "status", "--porcelain")).toBe(before);
    expect(git(busy, "worktree", "list")).toBe(worktrees);
    expect(git(busy, "branch", "--list")).toBe(branches);
  });
});
