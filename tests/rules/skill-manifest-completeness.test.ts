import { describe, it, expect } from "bun:test";
import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import { SKILL_MANIFESTS } from "../../src/rules/skills.js";

const SKILLS_ROOT = join(import.meta.dir, "../../templates/skills");

/** Every file under `dir`, as paths relative to it, using forward slashes. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    out.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

describe("skill manifests ship every file on disk", () => {
  it("leaves no file in templates/skills unshipped", async () => {
    // A file that exists in the repo but not in its manifest is never written by
    // installSkill, so the skill it belongs to references an asset its users do
    // not have. Nothing else in the suite catches that: the parity test walks
    // manifest -> disk, which an extra file on disk passes silently.
    const missing: string[] = [];

    for (const [name, manifest] of Object.entries(SKILL_MANIFESTS)) {
      const shipped = new Set(Object.keys(manifest));
      for (const rel of await filesUnder(join(SKILLS_ROOT, name))) {
        if (!shipped.has(rel)) missing.push(`${name}/${rel}`);
      }
    }

    expect(missing, `unshipped skill files: ${missing.join(", ")}`).toEqual([]);
  });
});
