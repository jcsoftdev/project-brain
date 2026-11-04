import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, symlink, lstat, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  assessFinish,
  createWorktree,
  finishWorktree,
  parseWorktreeList,
  pickTarget,
  resolveRepo,
  sweepWorktrees,
  type FinishFacts,
  type LifecycleDeps,
} from "../../src/commands/worktree-lifecycle.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const baseFacts: FinishFacts = {
  isMain: false,
  branch: "worktree/x",
  defaultBranch: "main",
  locked: false,
  prunable: false,
  merged: true,
  tipIsDefaultTip: false,
  ageMs: 10 * 60 * 60 * 1000,
  dirty: [],
  holders: [],
  cwdInside: false,
};

describe("assessFinish (pure rule)", () => {
  it("accepts a merged, clean, idle, non-main worktree", () => {
    expect(assessFinish(baseFacts)).toEqual({ finished: true, reasons: [] });
  });

  const refusals: [string, Partial<FinishFacts>, RegExp][] = [
    ["main checkout", { isMain: true }, /main checkout/],
    ["unmerged", { merged: false }, /not merged/],
    ["unknown merge state", { merged: null }, /could not determine/],
    ["dirty", { dirty: [" M a.ts"] }, /uncommitted/],
    ["busy", { holders: [42] }, /process 42/],
    ["unknown processes", { holders: null }, /could not tell/],
    ["cwd inside", { cwdInside: true }, /leave the directory/],
    ["detached", { branch: null }, /detached/],
    ["locked", { locked: true }, /locked/],
    ["on default branch", { branch: "main" }, /default branch/],
    ["unresolved default", { defaultBranch: null }, /default branch could not/],
    ["fresh and empty", { tipIsDefaultTip: true, ageMs: 1000 }, /under an hour/],
  ];
  for (const [name, patch, re] of refusals) {
    it(`refuses: ${name}`, () => {
      const r = assessFinish({ ...baseFacts, ...patch });
      expect(r.finished).toBe(false);
      expect(r.reasons.join(" ")).toMatch(re);
    });
  }

  it("accepts an old empty branch (zero commits ahead, long idle)", () => {
    expect(assessFinish({ ...baseFacts, tipIsDefaultTip: true }).finished).toBe(true);
  });
});

describe("lsofHolders", () => {
  it("sees a live process whose cwd is inside the directory, and ignores the excluded pid", async () => {
    const { lsofHolders } = await import("../../src/commands/worktree-lifecycle.js");
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "pb-wt-lsof-")));
    await mkdir(join(dir, "sub"));
    const child = Bun.spawn(["sleep", "30"], { cwd: join(dir, "sub") });
    try {
      await Bun.sleep(150);
      expect(lsofHolders(dir, process.pid)).toContain(child.pid);
      expect(lsofHolders(dir, child.pid)).not.toContain(child.pid);
      expect(lsofHolders(join(dir, "other"), process.pid)).toEqual([]);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseWorktreeList", () => {
  it("marks the first entry as main and reads branch, lock and prunable", () => {
    const out = [
      "worktree /r\nHEAD abc\nbranch refs/heads/main",
      "worktree /r/.claude/worktrees/a\nHEAD def\nbranch refs/heads/worktree/a\nlocked why",
      "worktree /elsewhere\nHEAD 123\ndetached\nprunable gone",
    ].join("\n\n");
    const list = parseWorktreeList(out);
    expect(list.map((e) => [e.isMain, e.branch, e.locked, e.prunable])).toEqual([
      [true, "main", false, false],
      [false, "worktree/a", true, false],
      [false, null, false, true],
    ]);
  });
});

describe("worktree lifecycle against real git repos", () => {
  let dir: string;
  let repo: string;
  let outside: string;
  let dropped: string[];
  let holders: Record<string, number[] | null>;
  let deps: LifecycleDeps;

  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "pb-wt-life-")));
    repo = join(dir, "checkout");
    outside = join(dir, "elsewhere");
    await mkdir(repo);
    await mkdir(outside);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "x\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
    dropped = [];
    holders = {};
    deps = {
      spawn: spawnSync,
      cwd: repo,
      holders: (p) => (p in holders ? holders[p]! : []),
      // far enough ahead that the fresh-worktree grace never interferes unless a test asks
      now: () => Date.now() + 48 * 60 * 60 * 1000,
      dropIndex: async (p) => {
        dropped.push(p);
      },
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function newWorktree(name: string, commit = true): Promise<string> {
    const { path } = await createWorktree(deps, { name, init: async () => {} });
    if (commit) {
      await writeFile(join(path, `${name}.txt`), "work\n");
      git(path, "add", `${name}.txt`);
      git(path, "commit", "-q", "-m", `feat: ${name}`);
    }
    return path;
  }

  const mergeIntoMain = (branch: string) => git(repo, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);

  async function finish(path: string, apply: boolean) {
    const r = resolveRepo(deps)!;
    return finishWorktree(r.entries.find((e) => e.path === path)!, r, deps, apply);
  }

  describe("create", () => {
    it("adds the worktree under .claude/worktrees on worktree/<name>, runs init, and ignores the dir locally", async () => {
      let initRoot = "";
      const result = await createWorktree(deps, { name: "alpha", init: async (r) => void (initRoot = r) });

      expect(result.path).toBe(join(repo, ".claude", "worktrees", "alpha"));
      expect(result.branch).toBe("worktree/alpha");
      expect(initRoot).toBe(result.path);
      expect(result.status.worktree).toBe("alpha");
      expect(git(result.path, "branch", "--show-current")).toBe("worktree/alpha");
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(await readFile(join(repo, ".git", "info", "exclude"), "utf-8")).toContain(".claude/worktrees/");
      // nothing tracked was touched
      expect(git(repo, "diff", "--stat")).toBe("");
    });

    it("excludes what init generates, so a fresh worktree is not dirty in a repo that ignores nothing", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { path } = await createWorktree(deps, {
        name: "gen",
        init: async (root) => {
          await runInit({ root, skipIndex: true, skipGitHook: true, dataDir: join(dir, "data") });
        },
      });
      expect(existsSync(join(path, ".project-brain", "project.json"))).toBe(true);
      expect(git(path, "status", "--porcelain")).toBe("");
      // anything else is still reported
      await writeFile(join(path, "notes.md"), "n\n");
      expect(git(path, "status", "--porcelain")).toBe("?? notes.md");
    });

    it("honours --base and --branch", async () => {
      await writeFile(join(repo, "b.txt"), "b\n");
      git(repo, "add", "b.txt");
      git(repo, "commit", "-q", "-m", "second");
      const { path, branch } = await createWorktree(deps, { name: "b", base: "HEAD~1", branch: "feat/custom", init: async () => {} });
      expect(branch).toBe("feat/custom");
      expect(existsSync(join(path, "b.txt"))).toBe(false);
    });

    it("refuses an existing path, an existing branch and a bad name, creating nothing", async () => {
      await createWorktree(deps, { name: "dup", init: async () => {} });
      await expect(createWorktree(deps, { name: "dup", init: async () => {} })).rejects.toThrow(/already exists/);
      git(repo, "branch", "taken");
      await expect(createWorktree(deps, { name: "n2", branch: "taken", init: async () => {} })).rejects.toThrow(/branch taken already exists/);
      expect(existsSync(join(repo, ".claude", "worktrees", "n2"))).toBe(false);
      await expect(createWorktree(deps, { name: "../escape", init: async () => {} })).rejects.toThrow(/invalid worktree name/);
    });
  });

  describe("finish safety boundaries", () => {
    it("never removes an unmerged branch", async () => {
      const path = await newWorktree("unmerged");
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(out.reasons.join()).toMatch(/not merged/);
      expect(existsSync(path)).toBe(true);
      expect(git(repo, "branch", "--list", "worktree/unmerged")).not.toBe("");
    });

    it("never removes a dirty tree (modified tracked file)", async () => {
      const path = await newWorktree("dirty");
      mergeIntoMain("worktree/dirty");
      await writeFile(join(path, "dirty.txt"), "changed\n");
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(existsSync(path)).toBe(true);
    });

    it("never removes a staged change", async () => {
      const path = await newWorktree("staged");
      mergeIntoMain("worktree/staged");
      await writeFile(join(path, "new.txt"), "n\n");
      git(path, "add", "new.txt");
      expect((await finish(path, true)).finished).toBe(false);
      expect(existsSync(path)).toBe(true);
    });

    it("never removes a tree with an untracked file that is not node_modules", async () => {
      const path = await newWorktree("untracked");
      mergeIntoMain("worktree/untracked");
      await writeFile(join(path, "notes.md"), "todo\n");
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(out.reasons.join()).toContain("notes.md");
      expect(existsSync(path)).toBe(true);
    });

    it("does not tolerate a real node_modules directory", async () => {
      const path = await newWorktree("realnm");
      mergeIntoMain("worktree/realnm");
      await mkdir(join(path, "node_modules"));
      await writeFile(join(path, "node_modules", "pkg.js"), "x\n");
      expect((await finish(path, true)).finished).toBe(false);
      expect(existsSync(path)).toBe(true);
    });

    it("never removes the main checkout", async () => {
      const r = resolveRepo(deps)!;
      const main = r.entries[0]!;
      const out = await finishWorktree(main, r, deps, true);
      expect(out.finished).toBe(false);
      expect(out.reasons.join()).toMatch(/main checkout/);
      expect(existsSync(repo)).toBe(true);
    });

    it("refuses when the invoking shell stands inside the worktree", async () => {
      const path = await newWorktree("cwd");
      mergeIntoMain("worktree/cwd");
      deps = { ...deps, cwd: join(path, "sub") };
      await mkdir(join(path, "sub"));
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(out.reasons.join()).toMatch(/leave the directory/);
      expect(existsSync(path)).toBe(true);
    });

    it("refuses when another process has it as cwd", async () => {
      const path = await newWorktree("busy");
      mergeIntoMain("worktree/busy");
      holders[path] = [4242];
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(out.reasons.join()).toMatch(/4242/);
      expect(existsSync(path)).toBe(true);
    });

    it("refuses when the process table is unreadable", async () => {
      const path = await newWorktree("blind");
      mergeIntoMain("worktree/blind");
      holders[path] = null;
      expect((await finish(path, true)).finished).toBe(false);
      expect(existsSync(path)).toBe(true);
    });

    it("dry run removes nothing even for a finished worktree", async () => {
      const path = await newWorktree("dry");
      mergeIntoMain("worktree/dry");
      const out = await finish(path, false);
      expect(out.finished).toBe(true);
      expect(out.removed).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(git(repo, "branch", "--list", "worktree/dry")).not.toBe("");
      expect(dropped).toEqual([]);
    });

    it("leaves a young empty worktree alone (created but not started)", async () => {
      const path = await newWorktree("fresh", false);
      deps = { ...deps, now: () => Date.now() };
      const out = await finish(path, true);
      expect(out.finished).toBe(false);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("finish removal", () => {
    it("removes directory and merged branch with -d, and drops the index", async () => {
      const path = await newWorktree("done");
      mergeIntoMain("worktree/done");
      const out = await finish(path, true);

      expect(out).toMatchObject({ finished: true, removed: true, branchDeleted: true });
      expect(existsSync(path)).toBe(false);
      expect(git(repo, "branch", "--list", "worktree/done")).toBe("");
      expect(dropped).toEqual([path]);
    });

    it("removes the lone node_modules symlink only, never its target", async () => {
      const path = await newWorktree("nm");
      mergeIntoMain("worktree/nm");
      const target = join(dir, "shared-node-modules");
      await mkdir(target);
      await writeFile(join(target, "keep.js"), "keep\n");
      await symlink(target, join(path, "node_modules"));

      const out = await finish(path, true);

      expect(out.removed).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(await readFile(join(target, "keep.js"), "utf-8")).toBe("keep\n");
    });

    it("tolerates the symlink in a dry run without touching it", async () => {
      const path = await newWorktree("nmdry");
      mergeIntoMain("worktree/nmdry");
      const target = join(dir, "t");
      await mkdir(target);
      await symlink(target, join(path, "node_modules"));
      const out = await finish(path, false);
      expect(out.finished).toBe(true);
      expect((await lstat(join(path, "node_modules"))).isSymbolicLink()).toBe(true);
    });

    it("keeps a symlink-plus-other-file worktree whole (symlink not removed on refusal)", async () => {
      const path = await newWorktree("nmdirty");
      mergeIntoMain("worktree/nmdirty");
      const target = join(dir, "t2");
      await mkdir(target);
      await symlink(target, join(path, "node_modules"));
      await writeFile(join(path, "scratch.txt"), "s\n");
      expect((await finish(path, true)).finished).toBe(false);
      expect((await lstat(join(path, "node_modules"))).isSymbolicLink()).toBe(true);
    });

    it("uses branch -d: a branch git considers unmerged survives the removal", async () => {
      // Merged into main by the rule, but main's HEAD is switched away so `-d` disagrees.
      const path = await newWorktree("guarded");
      mergeIntoMain("worktree/guarded");
      git(repo, "switch", "-q", "-c", "other", "HEAD~1");
      const out = await finish(path, true);

      expect(out.removed).toBe(true);
      expect(out.branchDeleted).toBe(false);
      expect(git(repo, "branch", "--list", "worktree/guarded")).not.toBe("");
    });

    it("never touches the default branch", async () => {
      const path = await newWorktree("keepmain");
      mergeIntoMain("worktree/keepmain");
      await finish(path, true);
      expect(git(repo, "branch", "--list", "main")).not.toBe("");
    });
  });

  describe("target resolution", () => {
    it("resolves a name under .claude/worktrees, a path, a branch, and the cwd's worktree", async () => {
      const path = await newWorktree("pick");
      const r = resolveRepo(deps)!;
      const got = (t?: string) => {
        const e = pickTarget(t, r, deps);
        return typeof e === "string" ? e : e.path;
      };
      expect(got("pick")).toBe(path);
      expect(got(path)).toBe(path);
      expect(got("worktree/pick")).toBe(path);
      expect(got("nope")).toMatch(/no worktree/);
      expect(got(undefined)).toBe(repo);
      deps = { ...deps, cwd: path };
      expect(got(undefined)).toBe(path);
    });
  });

  describe("sweep", () => {
    it("is a dry run by default, removes only finished ones with apply, and labels outside worktrees", async () => {
      const done = await newWorktree("done");
      mergeIntoMain("worktree/done");
      const open = await newWorktree("open");

      const sibling = join(dir, "sibling-wt");
      git(repo, "worktree", "add", "-q", "-b", "side/merged", sibling);
      await writeFile(join(sibling, "s.txt"), "s\n");
      git(sibling, "add", "s.txt");
      git(sibling, "commit", "-q", "-m", "side");
      mergeIntoMain("side/merged");

      const dry = (await sweepWorktrees(deps, { apply: false, branches: false }))!;
      expect(dry.worktrees.filter((o) => o.finished).map((o) => o.path).sort()).toEqual([done, sibling].sort());
      expect(dry.worktrees.find((o) => o.path === sibling)!.managed).toBe(false);
      expect(dry.worktrees.find((o) => o.path === done)!.managed).toBe(true);
      expect([done, open, sibling].every(existsSync)).toBe(true);

      const wet = (await sweepWorktrees(deps, { apply: true, branches: false }))!;
      expect(wet.worktrees.filter((o) => o.removed).map((o) => o.path)).toEqual([done]);
      expect(existsSync(done)).toBe(false);
      expect(existsSync(sibling)).toBe(true);
      expect(wet.worktrees.find((o) => o.path === sibling)).toMatchObject({ finished: true, heldBack: true, removed: false });
      expect(existsSync(open)).toBe(true);
      expect(git(repo, "branch", "--list", "worktree/open")).not.toBe("");
      expect(git(repo, "branch", "--list", "side/merged")).not.toBe("");

      const all = (await sweepWorktrees(deps, { apply: true, branches: false, includeOutside: true }))!;
      expect(all.worktrees.filter((o) => o.removed).map((o) => o.path)).toEqual([sibling]);
      expect(existsSync(sibling)).toBe(false);
      expect(existsSync(open)).toBe(true);
    });

    it("includeOutside alone never removes anything in a dry run", async () => {
      const sibling = join(dir, "sib2");
      git(repo, "worktree", "add", "-q", "-b", "side/two", sibling);
      await sweepWorktrees(deps, { apply: false, branches: false, includeOutside: true });
      expect(existsSync(sibling)).toBe(true);
    });

    it("finish with an explicit path removes an outside worktree, even through a symlinked path", async () => {
      const real = join(dir, "real-parent");
      await mkdir(real);
      await symlink(real, join(dir, "link-parent"));
      const viaLink = join(dir, "link-parent", "sib3");
      git(repo, "worktree", "add", "-q", "-b", "side/three", viaLink);
      await writeFile(join(viaLink, "t.txt"), "t\n");
      git(viaLink, "add", "t.txt");
      git(viaLink, "commit", "-q", "-m", "t");
      mergeIntoMain("side/three");

      const r = resolveRepo(deps)!;
      const entry = pickTarget(viaLink, r, deps);
      expect(typeof entry).not.toBe("string");
      const out = await finishWorktree(entry as Exclude<typeof entry, string>, r, deps, true);
      expect(out).toMatchObject({ managed: false, removed: true });
      expect(existsSync(join(real, "sib3"))).toBe(false);
    });

    it("treats a managed worktree reached through a symlinked repo path as managed", async () => {
      await newWorktree("viasym");
      mergeIntoMain("worktree/viasym");
      await symlink(repo, join(dir, "repo-link"));
      deps = { ...deps, cwd: realpathSync(join(dir, "repo-link")) };
      const res = (await sweepWorktrees(deps, { apply: true, branches: false }))!;
      expect(res.worktrees.find((o) => o.path.endsWith("viasym"))).toMatchObject({ managed: true, removed: true });
    });

    it("lists merged branches without a worktree, deleting them only with --branches", async () => {
      git(repo, "branch", "old/merged");
      git(repo, "switch", "-q", "-c", "old/unmerged");
      await writeFile(join(repo, "u.txt"), "u\n");
      git(repo, "add", "u.txt");
      git(repo, "commit", "-q", "-m", "u");
      git(repo, "switch", "-q", "main");

      const listed = (await sweepWorktrees(deps, { apply: true, branches: false }))!;
      expect(listed.branches.map((b) => b.name)).toEqual(["old/merged"]);
      expect(git(repo, "branch", "--list", "old/merged")).not.toBe("");

      const deleted = (await sweepWorktrees(deps, { apply: true, branches: true }))!;
      expect(deleted.branches[0]).toMatchObject({ name: "old/merged", deleted: true });
      expect(git(repo, "branch", "--list", "old/merged")).toBe("");
      expect(git(repo, "branch", "--list", "old/unmerged")).not.toBe("");
      expect(git(repo, "branch", "--list", "main")).not.toBe("");
    });

    it("does not delete branches in a dry run even with --branches", async () => {
      git(repo, "branch", "old/merged2");
      await sweepWorktrees(deps, { apply: false, branches: true });
      expect(git(repo, "branch", "--list", "old/merged2")).not.toBe("");
    });
  });
});
