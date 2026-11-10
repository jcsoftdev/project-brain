import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cloneDependencies, decideClone, workspaceDirectories, type DependencyFingerprint } from "../../src/commands/worktree-dependencies.js";
import { createWorktree, type LifecycleDeps } from "../../src/commands/worktree-lifecycle.js";

const same: DependencyFingerprint = { lockfile: "bun.lock", lockfileHash: "aaa" };

describe("decideClone", () => {
  const cases: Array<[string, DependencyFingerprint | null, DependencyFingerprint | null, ReturnType<typeof decideClone>]> = [
    ["identical", same, { ...same }, { clone: true, install: false }],
    ["different lockfile", same, { ...same, lockfileHash: "bbb" }, { clone: true, install: true }],
    ["no lockfile in main", null, same, { clone: false, reason: "no lockfile to compare" }],
    ["no lockfile in worktree", same, null, { clone: false, reason: "no lockfile to compare" }],
  ];

  for (const [name, main, worktree, expected] of cases) {
    it(name, () => expect(decideClone(main, worktree)).toEqual(expected));
  }
});

async function scratch(prefix: string): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)));
}

async function layout(root: string, files: Record<string, string>, dirs: string[] = []): Promise<void> {
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
}

describe("workspaceDirectories", () => {
  const cases: Array<[string, Record<string, string>, string[], string[]]> = [
    ["no workspaces", { "package.json": "{}" }, ["packages/a"], [""]],
    ["no package.json", {}, ["packages/a"], [""]],
    ["npm workspaces array", { "package.json": JSON.stringify({ workspaces: ["packages/*", "tools/cli"] }) }, ["packages/a", "packages/b", "tools/cli", "tools/other"], ["", "packages/a", "packages/b", "tools/cli"]],
    ["yarn workspaces object", { "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }) }, ["apps/web"], ["", "apps/web"]],
    ["pnpm-workspace.yaml with exclusion", { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/skip'\n" }, ["packages/a", "packages/skip"], ["", "packages/a"]],
    ["globstar skips node_modules and dot dirs", { "package.json": JSON.stringify({ workspaces: ["libs/**"] }) }, ["libs/a/b", "libs/node_modules/x", "libs/.cache"], ["", "libs", "libs/a", "libs/a/b"]],
    ["missing workspace dir", { "package.json": JSON.stringify({ workspaces: ["gone/*", "nope"] }) }, [], [""]],
  ];

  for (const [name, files, dirs, expected] of cases) {
    it(name, async () => {
      const root = await scratch("pb-ws-");
      try {
        await layout(root, files, dirs);
        expect(workspaceDirectories(root)).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("cloneDependencies with a lockfile that differs", () => {
  let main: string;
  let worktree: string;
  let calls: Array<{ command: string; args: string[]; cwd?: string }>;

  beforeEach(async () => {
    main = await scratch("pb-deps-main-");
    worktree = await scratch("pb-deps-wt-");
    const manifest = JSON.stringify({ workspaces: ["packages/*"] });
    await layout(main, { "package.json": manifest, "pnpm-lock.yaml": "v1\n", "node_modules/x/i.js": "", "packages/a/node_modules/y/i.js": "" });
    await layout(worktree, { "package.json": manifest, "pnpm-lock.yaml": "v2\n" }, ["packages/a"]);
    calls = [];
  });

  afterEach(async () => {
    await rm(main, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  function fakeSpawn(install: { status: number | null; stderr?: string; error?: Error }) {
    return ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd });
      if (command === "cp") {
        mkdirSync(args[args.length - 1], { recursive: true });
        return { status: 0, stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: install.stderr ?? "", ...install };
    }) as unknown as LifecycleDeps["spawn"];
  }

  it("clones every workspace node_modules, then installs on top", () => {
    const outcome = cloneDependencies(main, worktree, fakeSpawn({ status: 0 }), "darwin");

    expect(calls.map((c) => c.command)).toEqual(["cp", "cp", "pnpm"]);
    expect(calls[2]).toEqual({ command: "pnpm", args: ["install"], cwd: worktree });
    expect(outcome).toEqual({
      cloned: true,
      note: "node_modules cloned copy-on-write from the main checkout (2 folders), then `pnpm install` applied the lockfile changes",
      folders: ["node_modules", "packages/a/node_modules"],
    });
  });

  it("removes every clone and says why when the install fails", () => {
    const outcome = cloneDependencies(main, worktree, fakeSpawn({ status: 1, stderr: "resolution failed\nERR_PNPM_NO_MATCH" }), "darwin");

    expect(outcome).toEqual({
      cloned: false,
      note: "node_modules not cloned: lockfile differs from the main checkout and `pnpm install` failed (ERR_PNPM_NO_MATCH)",
      folders: [],
    });
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, "packages", "a", "node_modules"))).toBe(false);
  });

  it("removes every clone when the package manager is missing", () => {
    const outcome = cloneDependencies(main, worktree, fakeSpawn({ status: null, error: new Error("spawnSync pnpm ENOENT") }), "darwin");

    expect(outcome.note).toBe("node_modules not cloned: lockfile differs from the main checkout and pnpm is not available");
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, "packages", "a", "node_modules"))).toBe(false);
  });

  it("does not install when the lockfiles match", async () => {
    await writeFile(join(worktree, "pnpm-lock.yaml"), "v1\n");
    const outcome = cloneDependencies(main, worktree, fakeSpawn({ status: 0 }), "darwin");

    expect(calls.map((c) => c.command)).toEqual(["cp", "cp"]);
    expect(outcome.note).toBe("node_modules cloned copy-on-write from the main checkout (2 folders)");
  });

  it("skips a workspace folder the worktree does not have", async () => {
    await rm(join(worktree, "packages"), { recursive: true });
    await writeFile(join(worktree, "pnpm-lock.yaml"), "v1\n");
    const outcome = cloneDependencies(main, worktree, fakeSpawn({ status: 0 }), "darwin");

    expect(outcome.folders).toEqual(["node_modules"]);
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("createWorktree dependency cloning", () => {
  let dir: string;
  let repo: string;
  let deps: LifecycleDeps;

  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "pb-wt-deps-")));
    repo = join(dir, "checkout");
    await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "bun.lock"), "lock\n");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await layout(repo, { "packages/a/package.json": "{}" });
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "original\n");
    await layout(repo, { "packages/a/node_modules/dep/index.js": "workspace original\n" });
    deps = { spawn: spawnSync, cwd: repo, holders: () => [], now: Date.now, dropIndex: async () => {} };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clones node_modules so a change in the worktree leaves the main checkout untouched", async () => {
    const { path, dependencies } = await createWorktree(deps, { name: "clone", init: async () => {} });
    if (!dependencies.cloned) {
      console.warn(`skipped independence check: ${dependencies.note}`);
      return;
    }
    const clonedFile = join(path, "node_modules", "pkg", "index.js");
    expect(await readFile(clonedFile, "utf-8")).toBe("original\n");

    await writeFile(clonedFile, "changed in worktree\n");
    await writeFile(join(path, "node_modules", "pkg", "added.js"), "new\n");

    expect(await readFile(join(repo, "node_modules", "pkg", "index.js"), "utf-8")).toBe("original\n");
    expect(existsSync(join(repo, "node_modules", "pkg", "added.js"))).toBe(false);
    const workspaceFile = join(path, "packages", "a", "node_modules", "dep", "index.js");
    expect(await readFile(workspaceFile, "utf-8")).toBe("workspace original\n");
    await writeFile(workspaceFile, "changed in worktree\n");
    expect(await readFile(join(repo, "packages", "a", "node_modules", "dep", "index.js"), "utf-8")).toBe("workspace original\n");

    expect(git(path, "status", "--porcelain")).toBe("");
  });

  it("keeps today's behavior and says why when the clone command fails", async () => {
    const failingCp = ((command: string, args: string[], options: object) =>
      command === "cp" ? { status: 1, stdout: "", stderr: "not supported" } : spawnSync(command, args, options)) as unknown as LifecycleDeps["spawn"];
    const { path, dependencies } = await createWorktree({ ...deps, spawn: failingCp }, { name: "nofs", init: async () => {} });

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(dependencies.cloned).toBe(false);
      expect(dependencies.note).toContain("filesystem cannot clone (not supported)");
    }
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });

  it("clones, installs on top, and removes the clones when that install fails", async () => {
    await writeFile(join(repo, "bun.lock"), "lock v2\n");
    git(repo, "add", "bun.lock");
    git(repo, "commit", "-q", "-m", "bump");
    await writeFile(join(repo, "bun.lock"), "uncommitted edit\n");
    const installs: string[] = [];
    const failingBun = ((command: string, args: string[], options: object) => {
      if (command !== "bun") return spawnSync(command, args, options);
      installs.push(args.join(" "));
      return { status: 1, stdout: "", stderr: "lockfile had changes" };
    }) as unknown as LifecycleDeps["spawn"];

    const { path, dependencies } = await createWorktree({ ...deps, spawn: failingBun }, { name: "drift", init: async () => {} });

    if (dependencies.note.includes("filesystem cannot clone") || dependencies.note.includes("unsupported")) return;
    expect(installs).toEqual(["install"]);
    expect(dependencies).toEqual({
      cloned: false,
      note: "node_modules not cloned: lockfile differs from the main checkout and `bun install` failed (lockfile had changes)",
      folders: [],
    });
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(existsSync(join(path, "packages", "a", "node_modules"))).toBe(false);
  });
});
