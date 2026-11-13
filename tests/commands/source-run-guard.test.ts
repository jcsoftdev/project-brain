import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompiledEntry, mayWriteGlobalState, type GlobalWriteStep } from "../../src/env/install-origin.js";
import { installSkill, STAMP_FILE, GENERATOR_MARKER } from "../../src/rules/skills.js";

const COMPILED_MAC = "/$bunfs/root/project-brain";
const COMPILED_WINDOWS = "B:\\~BUN\\root\\project-brain.exe";
const WORKTREE_SOURCE = "/Users/me/repo/.claude/worktrees/agent-1/src/cli.ts";
const CHECKOUT_SOURCE = "/Users/me/repo/src/cli.ts";

describe("isCompiledEntry", () => {
  it.each([
    [COMPILED_MAC, true],
    [COMPILED_WINDOWS, true],
    ["file:///B:/%7EBUN/root/project-brain.exe", true],
    [WORKTREE_SOURCE, false],
    [CHECKOUT_SOURCE, false],
  ])("%s -> %p", (main, expected) => {
    expect(isCompiledEntry(main)).toBe(expected);
  });
});

describe("mayWriteGlobalState", () => {
  const cases: [string, GlobalWriteStep, string, Record<string, string>, boolean][] = [
    ["installed binary refreshes skills", "skill-refresh", COMPILED_MAC, {}, true],
    ["installed Windows binary repairs configs", "config-repair", COMPILED_WINDOWS, {}, true],
    ["worktree source run does not refresh skills", "skill-refresh", WORKTREE_SOURCE, {}, false],
    ["main checkout source run does not refresh skills", "skill-refresh", CHECKOUT_SOURCE, {}, false],
    ["source run does not repair configs", "config-repair", WORKTREE_SOURCE, {}, false],
    ["source run does not add the suggest hook", "suggest-hook", WORKTREE_SOURCE, {}, false],
    ["force unlocks skills from source", "skill-refresh", WORKTREE_SOURCE, { BRAIN_FORCE_SKILL_REFRESH: "1" }, true],
    ["force unlocks config repair from source", "config-repair", WORKTREE_SOURCE, { BRAIN_FORCE_SKILL_REFRESH: "1" }, true],
    ["force accepts only 1", "skill-refresh", WORKTREE_SOURCE, { BRAIN_FORCE_SKILL_REFRESH: "true" }, false],
    ["opt-out stops the installed binary", "skill-refresh", COMPILED_MAC, { BRAIN_NO_SKILL_REFRESH: "1" }, false],
    [
      "opt-out beats force",
      "skill-refresh",
      WORKTREE_SOURCE,
      { BRAIN_NO_SKILL_REFRESH: "1", BRAIN_FORCE_SKILL_REFRESH: "1" },
      false,
    ],
    ["config opt-out stops the installed binary", "config-repair", COMPILED_MAC, { BRAIN_NO_CONFIG_REPAIR: "1" }, false],
    ["skill opt-out leaves config repair alone", "config-repair", COMPILED_MAC, { BRAIN_NO_SKILL_REFRESH: "1" }, true],
  ];

  it.each(cases)("%s", (_name, step, main, env, expected) => {
    expect(mayWriteGlobalState(step, main, env)).toBe(expected);
  });
});

/**
 * The guard lives in cli.ts's top-level preamble, so only a spawned CLI proves the
 * wiring. This test file runs from the repository checkout (a worktree, for agents),
 * which is exactly the source run that must leave the owner's skills alone.
 */
describe("a source run of the CLI", () => {
  let home: string;
  let skillMd: string;
  const staleContent = `---\nname: brain-audit\nmetadata:\n  ${GENERATOR_MARKER}\n---\nolder content\n`;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "source-run-home-"));
    const root = join(home, ".claude", "skills");
    await installSkill([root]);
    const skillDir = join(root, "brain-audit");
    skillMd = join(skillDir, "SKILL.md");
    await writeFile(join(skillDir, STAMP_FILE), "an-older-release\n");
    await writeFile(skillMd, staleContent);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function runCli(extra: Record<string, string>): Promise<string> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      BRAIN_NO_UPDATE_CHECK: "1",
      BRAIN_NO_CONFIG_REPAIR: "1",
      ...extra,
    };
    if (!("BRAIN_NO_SKILL_REFRESH" in extra)) delete env.BRAIN_NO_SKILL_REFRESH;
    if (!("BRAIN_FORCE_SKILL_REFRESH" in extra)) delete env.BRAIN_FORCE_SKILL_REFRESH;
    const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], { env, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return stderr;
  }

  it("leaves a stale installed skill untouched", async () => {
    const stderr = await runCli({});

    expect(await readFile(skillMd, "utf8")).toBe(staleContent);
    expect(stderr).not.toContain("to match this version");
  }, 30_000);

  it("refreshes it when the maintainer forces it", async () => {
    const stderr = await runCli({ BRAIN_FORCE_SKILL_REFRESH: "1" });

    expect(await readFile(skillMd, "utf8")).not.toBe(staleContent);
    expect(stderr).toContain("to match this version");
  }, 30_000);
});
