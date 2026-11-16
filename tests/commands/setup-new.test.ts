import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, runSetupNew, type SetupOptions } from "../../src/commands/setup.js";
import { writeRerankerToken } from "../../src/rerank/token.js";
import { loadSelection, membership } from "../../src/setup/selection.js";
import { allUnits, type SetupContext } from "../../src/setup/units.js";

// Units that write only under the temporary dir: on by default, opt-in, and on only when a token exists.
const DEFAULT_ON = "feature:task-switch";
const OPT_IN = "config:mcp-prune-jev";
const TOKEN_GATED = "hooks:commit-check";
const NEW = [DEFAULT_ON, OPT_IN, TOKEN_GATED];
const OLD_SELECTED = "feature:search-gate";
const OLD_DECLINED = "feature:conceptualize";

let dir: string;
let dataDir: string;
let selectionPath: string;
let probe: SetupContext;
let ids: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-setup-new-"));
  dataDir = join(dir, "data");
  selectionPath = join(dataDir, "setup-selection.json");
  await mkdir(dataDir, { recursive: true });
  // The default-on unit starts switched off, so it is absent rather than current.
  await writeFile(join(dataDir, "features.json"), JSON.stringify({ "task-switch": false }));
  // A token makes the commit-check hook default-on through `defaultWhen`.
  await writeRerankerToken(dataDir, "test-token");
  probe = {
    dataDir,
    installed: [],
    selectionPath,
    claudeSettingsPath: join(dir, "settings.json"),
    routingConfigPath: join(dir, "model-routing.json"),
    skillTargetDirs: [],
  } as unknown as SetupContext;
  ids = allUnits(probe).map((u) => u.id);
  // A selection written before the new units shipped: every other id was offered and answered.
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

const common: () => Partial<SetupOptions> = () => ({
  dataDir,
  skipOllama: true,
  registrars: [],
  skillTargetDirs: [],
  claudeSettingsPath: probe.claudeSettingsPath,
  routingConfigPath: probe.routingConfigPath,
  selectionPath,
  quiet: true,
});
const run = (over: Partial<SetupOptions>) => runSetup({ ...common(), onlyNew: true, ...over });
const cli = async (args: string[]) => {
  const printed: string[] = [];
  const code = await runSetupNew(["--new", ...args], ids, probe, { interactive: false, print: (l) => printed.push(l), setup: common() });
  return { code, out: printed.join("\n") };
};
const features = async () => JSON.parse(await readFile(join(dataDir, "features.json"), "utf8")) as Record<string, boolean>;
const saved = async () => (await loadSelection(selectionPath))!;

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

    const s = await saved();
    expect(s.selected.sort()).toEqual([OLD_SELECTED, OPT_IN].sort());
    expect(s.declined).toContain(DEFAULT_ON);
    expect(s.declined).toContain(OLD_DECLINED);
  });

  it("never offers a unit again once it was declined", async () => {
    await run({ promptUnitSelection: async () => [] });
    let asked = false;
    const result = await run({ promptUnitSelection: async () => ((asked = true), []) });

    expect(asked).toBe(false);
    expect(result.units).toEqual([]);
  });

  it("--yes enables only the unconditionally default-on unit, never one a token turns on or an opt-in one", async () => {
    const { code, out } = await cli(["--yes"]);

    expect(code).toBe(0);
    expect(out).toContain(`Enabled: ${DEFAULT_ON}`);
    expect((await features())["task-switch"]).toBe(true);
    expect((await features())["mcp-prune-jev"]).toBeUndefined();
    expect(await readFile(probe.claudeSettingsPath, "utf8").catch(() => "")).not.toContain("commit-check");

    const s = await saved();
    expect(membership(s, DEFAULT_ON)).toBe("selected");
    expect(membership(s, OPT_IN)).toBe("unseen");
    expect(membership(s, TOKEN_GATED)).toBe("unseen");
  });

  it("--with enables what it names and leaves every other new unit undecided; an old id is left alone", async () => {
    const { code, out } = await cli([`--with=${OPT_IN},${OLD_DECLINED}`]);

    expect(code).toBe(0);
    const s = await saved();
    expect(membership(s, OPT_IN)).toBe("selected");
    expect(membership(s, DEFAULT_ON)).toBe("unseen");
    expect(membership(s, TOKEN_GATED)).toBe("unseen");
    expect(membership(s, OLD_DECLINED)).toBe("declined");
    expect(out).toContain(`Not new, left as they are: ${OLD_DECLINED}`);
  });

  it("--without declines only what it names and enables nothing", async () => {
    await cli([`--without=${TOKEN_GATED}`]);

    const s = await saved();
    expect(membership(s, TOKEN_GATED)).toBe("declined");
    expect(membership(s, OPT_IN)).toBe("unseen");
    expect((await features())["mcp-prune-jev"]).toBeUndefined();
  });

  it("refuses --all and --yes with --with, writing nothing", async () => {
    const before = await readFile(selectionPath, "utf8");
    expect((await cli(["--all"])).code).toBe(1);
    expect((await cli(["--yes", `--with=${OPT_IN}`])).code).toBe(1);
    expect(await readFile(selectionPath, "utf8")).toBe(before);
  });

  it("without a TTY or a flag, lists the new units and writes nothing", async () => {
    const before = await readFile(selectionPath, "utf8");
    const files = await readdir(dataDir);

    const { code, out } = await cli([]);

    expect(code).toBe(0);
    for (const id of NEW) expect(out).toContain(id);
    expect(await readFile(selectionPath, "utf8")).toBe(before);
    expect(await readdir(dataDir)).toEqual(files);
    expect((await features())["task-switch"]).toBe(false);
  });
});

describe("plain setup", () => {
  it("still offers every unit and records the whole answer", async () => {
    let offered = 0;
    await runSetup({ ...common(), promptUnitSelection: async (rows) => ((offered = rows.length), [OLD_SELECTED]) });

    expect(offered).toBe(ids.length);
    const s = await saved();
    expect(s.selected).toEqual([OLD_SELECTED]);
    expect(s.declined).toContain(DEFAULT_ON);
    expect(s.declined).toContain(OPT_IN);
  });
});
