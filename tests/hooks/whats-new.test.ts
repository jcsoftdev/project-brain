import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuggest, whatsNewNoticeFor, type WhatsNewOptions } from "../../src/commands/suggest.js";
import { findNewUnits, refreshWhatsNew } from "../../src/commands/setup.js";
import { readWhatsNewCache, writeWhatsNewCache } from "../../src/setup/selection.js";
import { allUnits, type SetupContext, type SetupUnit, type UnitState } from "../../src/setup/units.js";

const VERSION = "0.46.0";
const unit = (n: number) => ({ id: `tui:unit-${n}`, label: `Unit ${n}`, description: `does thing ${n}; and more detail` });

let dataDir: string;
let selectionPath: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pb-whats-new-"));
  selectionPath = join(dataDir, "setup-selection.json");
  await select([], []);
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

const select = (selected: string[], declined: string[]) =>
  writeFile(selectionPath, JSON.stringify({ version: 1, updatedAt: "", binaryVersion: "0.44.0", selected, declined }));
const cache = (units: ReturnType<typeof unit>[], version = VERSION) => writeWhatsNewCache(dataDir, { version, units, unknown: [] });
const take = (over: Partial<WhatsNewOptions> = {}) =>
  whatsNewNoticeFor({ dataDir, version: VERSION, env: {}, installed: true, ...over });
const claims = async () => (existsSync(join(dataDir, "whats-new-claims")) ? readdir(join(dataDir, "whats-new-claims")) : []);

describe("what's-new notice (prompt hook)", () => {
  it("names the new units and the command, claims before printing, and announces each unit once", async () => {
    await cache([unit(1), unit(2)]);

    const first = await take();
    expect(first?.text).toContain(`project-brain ${VERSION} has 2 setup units you have not chosen yet`);
    expect(first?.text).toContain("- tui:unit-1: Unit 1, does thing 1");
    expect(first?.text).not.toContain("and more detail");
    expect(first?.text).toContain("`project-brain setup --new`");
    // Claimed already: a second prompt shows nothing even before the first one committed.
    expect(await take()).toBeNull();
    await first!.commit();

    // The next release does not repeat units already announced, even if still undecided.
    await cache([unit(1), unit(2)], "0.47.0");
    expect(await take({ version: "0.47.0" })).toBeNull();
    // A unit found later shows on its own.
    await cache([unit(1), unit(2), unit(3)], "0.47.0");
    const later = await take({ version: "0.47.0" });
    expect(later?.text).toContain("has a setup unit");
    expect(later?.text).toContain("tui:unit-3");
    expect(later?.text).not.toContain("tui:unit-1");
  });

  it("lists at most five units, then counts the rest", async () => {
    await cache([1, 2, 3, 4, 5, 6, 7].map(unit));
    const text = (await take())!.text;
    expect(text).toContain("tui:unit-5");
    expect(text).not.toContain("tui:unit-6");
    expect(text).toContain("+2 more");
  });

  it("skips a unit declined after the list was computed, and a cache for another version", async () => {
    await cache([unit(1), unit(2)]);
    await select([], ["tui:unit-1"]);
    expect((await take())?.text).not.toContain("tui:unit-1");

    await cache([unit(3)], "0.45.0");
    expect(await take()).toBeNull();
  });

  it("treats an unreadable selection as unknown: nothing shown, nothing claimed, shown once it reads", async () => {
    await cache([unit(1)]);
    await writeFile(selectionPath, "{half-writ");
    expect(await take()).toBeNull();
    expect(await claims()).toEqual([]);

    await select([], []);
    expect(await take()).not.toBeNull();
  });

  it("stays silent with PROJECT_BRAIN_WHATS_NEW=0, and from a source checkout", async () => {
    await cache([unit(1)]);
    expect(await take({ env: { PROJECT_BRAIN_WHATS_NEW: "0" } })).toBeNull();
    expect(await take({ installed: false })).toBeNull();
    expect(await claims()).toEqual([]);
  });

  it("is shown by exactly one of two sessions prompting at once", async () => {
    await cache([unit(1)]);
    const both = await Promise.all([take(), take(), take()]);
    expect(both.filter((n) => n !== null).length).toBe(1);
  });

  it("is printed by the prompt hook and recorded only after printing", async () => {
    const events: string[] = [];
    await runSuggest(JSON.stringify({ prompt: "please refactor the parser", cwd: "/work/app", session_id: "s1" }), {
      print: (l) => events.push(l),
      pick: async () => [],
      upgradeNotice: async () => null,
      whatsNew: async () => ({ text: "project-brain 0.46.0 has a setup unit", commit: async () => void events.push("commit") }),
    });
    expect(events).toEqual(["project-brain 0.46.0 has a setup unit", "commit"]);
  });

  it("costs the prompt nothing when a unit's inspection hangs: it is computed between sessions", async () => {
    const hang = fake("tui:slow", () => new Promise<UnitState>(() => {}));
    const fast = fake("tui:fast", async () => "absent");
    const ctx = { selectionPath } as unknown as SetupContext;
    await refreshWhatsNew({ dataDir, version: VERSION, find: () => findNewUnits(ctx, 30, [hang, fast]) });

    const printed: string[] = [];
    const started = performance.now();
    await runSuggest(JSON.stringify({ prompt: "please refactor the parser", cwd: "/work/app", session_id: "s1" }), {
      print: (l) => printed.push(l),
      pick: async () => [],
      upgradeNotice: async () => null,
      whatsNew: () => take(),
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(printed.join("\n")).toContain("tui:fast");
    expect(printed.join("\n")).not.toContain("tui:slow");
  });
});

function fake(id: string, inspect: () => Promise<UnitState>): SetupUnit {
  return { id, group: "Claude TUI", label: id, description: "a unit", defaultSelected: false, inspect, apply: async () => {}, remove: async () => {} };
}

describe("findNewUnits and refreshWhatsNew (between sessions)", () => {
  it("returns only units the selection never saw and that are not on disk; declined ones never", async () => {
    const ctx = {
      dataDir,
      installed: [],
      selectionPath,
      claudeSettingsPath: join(dataDir, "settings.json"),
      routingConfigPath: join(dataDir, "model-routing.json"),
    } as unknown as SetupContext;
    // task-switch: unseen and off (new). search-gate: off but declined. conceptualize: unseen but on (not news).
    await writeFile(join(dataDir, "features.json"), JSON.stringify({ "task-switch": false, "search-gate": false }));
    const unseen = ["feature:task-switch", "feature:conceptualize", "config:mcp-prune-jev"];
    await select([], allUnits(ctx).map((u) => u.id).filter((id) => !unseen.includes(id)));

    const found = await findNewUnits(ctx);

    expect(found?.unknown).toEqual([]);
    expect(found?.units.map((u) => u.id).sort()).toEqual(["config:mcp-prune-jev", "feature:task-switch"]);
  });

  it("records a unit whose inspection times out as unknown, and looks at it again on the next run", async () => {
    let slowAnswers = false;
    const slow = fake("tui:slow", () => (slowAnswers ? Promise.resolve("absent") : new Promise<UnitState>(() => {})));
    const fast = fake("tui:fast", async () => "absent");
    const ctx = { selectionPath } as unknown as SetupContext;
    let runs = 0;
    const find = () => ((runs += 1), findNewUnits(ctx, 30, [slow, fast]));

    await refreshWhatsNew({ dataDir, version: VERSION, find });
    expect(await readWhatsNewCache(dataDir)).toEqual({
      version: VERSION,
      units: [{ id: "tui:fast", label: "tui:fast", description: "a unit" }],
      unknown: ["tui:slow"],
    });

    slowAnswers = true;
    await refreshWhatsNew({ dataDir, version: VERSION, find });
    expect((await readWhatsNewCache(dataDir))?.units.map((u) => u.id)).toEqual(["tui:slow", "tui:fast"]);
    expect((await readWhatsNewCache(dataDir))?.unknown).toEqual([]);

    // Complete for this version: not computed again.
    await refreshWhatsNew({ dataDir, version: VERSION, find });
    expect(runs).toBe(2);
  });

  it("reports nothing new without a selection, and writes no cache when the selection is unreadable", async () => {
    await rm(selectionPath);
    expect(await findNewUnits({ selectionPath } as unknown as SetupContext)).toEqual({ units: [], unknown: [] });

    await writeFile(selectionPath, "{half-writ");
    expect(await findNewUnits({ selectionPath } as unknown as SetupContext)).toBeNull();
    await refreshWhatsNew({ dataDir, version: VERSION, find: () => findNewUnits({ selectionPath } as unknown as SetupContext) });
    expect(await readWhatsNewCache(dataDir)).toBeNull();
  });
});
