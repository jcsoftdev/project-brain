import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ACTIVITY_PANE_FILES, ACTIVITY_PLUGIN_NAME } from "../../src/setup/claude-tui.js";

const root = join(import.meta.dir, "../../templates/claude-tui/activity-pane");

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(relative(root, path));
  }
  return out;
}

describe("activity-pane template parity", () => {
  it("embeds every file under templates/claude-tui/activity-pane", async () => {
    expect(Object.keys(ACTIVITY_PANE_FILES).sort()).toEqual((await filesUnder(root)).sort());
  });

  it("every embedded string equals its file on disk", async () => {
    for (const [rel, text] of Object.entries(ACTIVITY_PANE_FILES)) {
      expect(typeof text, rel).toBe("string");
      expect(await readFile(join(root, rel), "utf8"), `${rel} drifted`).toBe(text);
    }
  });

  it("names the plugin, its state key and its command consistently", () => {
    expect(JSON.parse(ACTIVITY_PANE_FILES[".claude-plugin/plugin.json"]!).name).toBe(ACTIVITY_PLUGIN_NAME);
    expect(ACTIVITY_PANE_FILES["types/index.d.ts"]).toContain(`'${ACTIVITY_PLUGIN_NAME}': {`);
    const register = ACTIVITY_PANE_FILES["hooks/register.tsx"]!;
    expect(register).not.toContain("tool-detail");
    expect(register).toContain(`plugin: '${ACTIVITY_PLUGIN_NAME}'`);
    expect(register).toContain("name: 'activity'");
  });
});
