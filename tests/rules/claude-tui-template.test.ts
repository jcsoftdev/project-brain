import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ACTIVITY_PANE_FILES,
  ACTIVITY_PLUGIN_NAME,
  CONTEXT_GATE_FILES,
  CONTEXT_GATE_PLUGIN_NAME,
  SKILL_LISTING_FILES,
  SKILL_LISTING_PLUGIN_NAME,
} from "../../src/setup/claude-tui.js";

const templates = join(import.meta.dir, "../../templates/claude-tui");

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(root, path)));
    else out.push(relative(root, path));
  }
  return out;
}

const MODS = [
  { dir: "activity-pane", name: ACTIVITY_PLUGIN_NAME, files: ACTIVITY_PANE_FILES },
  { dir: "skill-listing", name: SKILL_LISTING_PLUGIN_NAME, files: SKILL_LISTING_FILES },
  { dir: "context-gate", name: CONTEXT_GATE_PLUGIN_NAME, files: CONTEXT_GATE_FILES },
];

for (const { dir, name, files } of MODS) {
  describe(`${dir} template parity`, () => {
    const root = join(templates, dir);

    it(`embeds every file under templates/claude-tui/${dir}`, async () => {
      expect(Object.keys(files).sort()).toEqual((await filesUnder(root)).sort());
    });

    it("every embedded string equals its file on disk", async () => {
      for (const [rel, text] of Object.entries(files)) {
        expect(typeof text, rel).toBe("string");
        expect(await readFile(join(root, rel), "utf8"), `${rel} drifted`).toBe(text);
      }
    });

    it("names the plugin in its manifest", () => {
      expect(JSON.parse(files[".claude-plugin/plugin.json"]!).name).toBe(name);
      expect(files["hooks/register.tsx"]).not.toContain("tool-detail");
    });
  });
}

describe("activity-pane names", () => {
  it("names its state key and its command consistently", () => {
    expect(ACTIVITY_PANE_FILES["types/index.d.ts"]).toContain(`'${ACTIVITY_PLUGIN_NAME}': {`);
    const register = ACTIVITY_PANE_FILES["hooks/register.tsx"]!;
    expect(register).toContain(`plugin: '${ACTIVITY_PLUGIN_NAME}'`);
    expect(register).toContain("name: 'activity'");
  });
});

describe("mod types", () => {
  it("are self-contained: no import() and no import statement", () => {
    expect(SKILL_LISTING_FILES["types/index.d.ts"]).not.toMatch(/\bimport\b/);
    expect(CONTEXT_GATE_FILES["types/index.d.ts"]).not.toMatch(/\bimport\b/);
  });
});
