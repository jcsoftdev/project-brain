import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, type SetupOptions } from "../../src/commands/setup.js";
import { loadSelection } from "../../src/setup/selection.js";
import { allUnits, type SetupContext } from "../../src/setup/units.js";

// Two feature units, both writing only <dataDir>/features.json: one on by default, one opt-in.
const DEFAULT_ON = "feature:task-switch";
const OPT_IN = "config:mcp-prune-jev";
const NEW = [DEFAULT_ON, OPT_IN];
const OLD_SELECTED = "feature:search-gate";

let dir: string;
let dataDir: string;
let selectionPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-setup-new-"));
  dataDir = join(dir, "data");
  selectionPath = join(dataDir, "setup-selection.json");
  await mkdir(dataDir, { recursive: true });
  // The default-on unit starts switched off, so it is absent rather than current.
  await writeFile(join(dataDir, "features.json"), JSON.stringify({ "task-switch": false }));
  // A selection written before the two units shipped: every other id was offered and answered.
  const ids = allUnits({ installed: [] } as unknown as SetupContext).map((u) => u.id);
  const answered = ids.filter((id) => !NEW.includes(id));
  await writeFile(
    selectionPath,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-11-01T00:00:00.000Z",
      binaryVersion: "0.44.0",
      selected: [OLD_SELECTED],
      declined: answered.filter((id) => id !== OLD_SELECTED),
    })
  );
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = (over: Partial<SetupOptions>) =>
  runSetup({
    dataDir,
    skipOllama: true,
    registrars: [],
    skillTargetDirs: [],
    claudeSettingsPath: join(dir, "settings.json"),
    routingConfigPath: join(dir, "model-routing.json"),
    selectionPath,
    onlyNew: true,
    quiet: true,
    ...over,
  });

const features = async () => JSON.parse(await readFile(join(dataDir, "features.json"), "utf8")) as Record<string, boolean>;

describe("setup --new", () => {
  it("offers only the new units, applies the ticked one, and keeps every earlier answer", async () => {
    let offered: string[] = [];
    const result = await run({
      promptUnitSelection: async (rows) => {
        offered = rows.map((r) => r.id);
        return [OPT_IN];
      },
    });

    expect(offered.sort()).toEqual([...NEW].sort());
    expect(result.units.map((u) => u.id).sort()).toEqual([...NEW].sort());
    expect((await features())["mcp-prune-jev"]).toBe(true);
    expect((await features())["task-switch"]).toBe(false);

    const saved = (await loadSelection(selectionPath))!;
    expect(saved.selected.sort()).toEqual([OLD_SELECTED, OPT_IN].sort());
    expect(saved.declined).toContain(DEFAULT_ON);
    expect(saved.declined).toContain("hooks:report-contract");
  });

  it("never offers a unit again once it was declined", async () => {
    await run({ promptUnitSelection: async () => [] });
    let asked = false;
    const result = await run({ promptUnitSelection: async () => ((asked = true), []) });

    expect(asked).toBe(false);
    expect(result.units).toEqual([]);
  });

  it("--yes enables only the on-by-default unit and leaves the opt-in one undecided", async () => {
    const result = await run({ acceptDefaults: true });

    expect(result.units.find((u) => u.id === DEFAULT_ON)?.action).toBe("install");
    expect(result.units.find((u) => u.id === OPT_IN)?.action).toBe("unchanged");
    expect((await features())["task-switch"]).toBe(true);
    expect((await features())["mcp-prune-jev"]).toBeUndefined();

    const saved = (await loadSelection(selectionPath))!;
    expect(saved.selected).toContain(DEFAULT_ON);
    expect(saved.selected).not.toContain(OPT_IN);
    expect(saved.declined).not.toContain(OPT_IN);
  });

  it("--with touches only new units, even when it names an old one", async () => {
    const result = await run({ units: { mode: "explicit", selected: [OPT_IN, "feature:conceptualize"] } });

    expect(result.units.map((u) => u.id).sort()).toEqual([...NEW].sort());
    const saved = (await loadSelection(selectionPath))!;
    expect(saved.selected).toContain(OPT_IN);
    expect(saved.declined).toContain("feature:conceptualize");
    expect(saved.declined).toContain(DEFAULT_ON);
  });
});
