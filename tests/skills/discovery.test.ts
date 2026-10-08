import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/discovery.js";

let root: string;
let home: string;
let project: string;
let cacheDir: string;

async function skill(dir: string, folder: string, frontmatter: string): Promise<void> {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, "SKILL.md"), frontmatter);
}

const doc = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pb-skills-"));
  home = join(root, "home");
  project = join(root, "proj");
  cacheDir = join(root, "cache");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("reads user, project, agents and plugin skills", async () => {
    await skill(join(home, ".claude", "skills"), "a", doc("alpha", "does alpha"));
    await skill(join(project, ".claude", "skills"), "b", doc("beta", "does beta"));
    await skill(join(home, ".agents", "skills"), "c", doc("gamma", "does gamma"));

    const install = join(home, ".claude", "plugins", "cache", "caveman");
    await skill(join(install, "skills"), "d", doc("delta", "does delta"));
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "caveman@market": [{ installPath: install }] } })
    );

    const names = (await discoverSkills({ home, projectDir: project, cacheDir })).map((s) => s.name);
    expect(names.sort()).toEqual(["alpha", "beta", "caveman:delta", "gamma"]);
  });

  it("skips malformed frontmatter and entries missing name or description", async () => {
    const dir = join(home, ".claude", "skills");
    await skill(dir, "ok", doc("ok", "fine"));
    await skill(dir, "broken", "---\nname: [unclosed\n---\n");
    await skill(dir, "nofm", "no frontmatter here");
    await skill(dir, "nodesc", "---\nname: lonely\n---\n");

    const skills = await discoverSkills({ home, projectDir: project, cacheDir });
    expect(skills.map((s) => s.name)).toEqual(["ok"]);
  });

  it("dedupes by name, project winning over user", async () => {
    await skill(join(home, ".claude", "skills"), "x", doc("same", "user copy"));
    await skill(join(project, ".claude", "skills"), "x", doc("same", "project copy"));

    const skills = await discoverSkills({ home, projectDir: project, cacheDir });
    expect(skills).toEqual([{ name: "same", description: "project copy" }]);
  });

  it("serves from the cache while roots are unchanged, and rescans when a root changes", async () => {
    const dir = join(home, ".claude", "skills");
    await skill(dir, "a", doc("alpha", "one"));
    const first = await discoverSkills({ home, projectDir: project, cacheDir });
    expect(first).toHaveLength(1);

    // Editing an existing file leaves the root mtime alone: still the cached answer.
    await writeFile(join(dir, "a", "SKILL.md"), doc("alpha", "edited"));
    expect((await discoverSkills({ home, projectDir: project, cacheDir }))[0]!.description).toBe("one");

    // Adding a skill bumps the root mtime → rescan.
    await skill(dir, "b", doc("beta", "two"));
    const later = new Date(Date.now() + 5000);
    await utimes(dir, later, later);
    const rescanned = await discoverSkills({ home, projectDir: project, cacheDir });
    expect(rescanned.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(rescanned.find((s) => s.name === "alpha")!.description).toBe("edited");
  });

  it("rescans once the TTL lapses", async () => {
    const dir = join(home, ".claude", "skills");
    await skill(dir, "a", doc("alpha", "one"));
    await discoverSkills({ home, projectDir: project, cacheDir, now: () => 0 });
    await writeFile(join(dir, "a", "SKILL.md"), doc("alpha", "edited"));

    const stale = await discoverSkills({ home, projectDir: project, cacheDir, now: () => 11 * 60_000 });
    expect(stale[0]!.description).toBe("edited");
  });

  it("returns [] when nothing exists", async () => {
    expect(await discoverSkills({ home, projectDir: project, cacheDir })).toEqual([]);
  });
});
