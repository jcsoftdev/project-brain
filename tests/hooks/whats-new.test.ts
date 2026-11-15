import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuggest, whatsNewNoticeFor, type WhatsNewOptions } from "../../src/commands/suggest.js";
import { findNewUnits, type NewUnits } from "../../src/commands/setup.js";
import { allUnits, type SetupContext } from "../../src/setup/units.js";

const INSTALLED = "/$bunfs/root/project-brain";
const unit = (n: number) => ({ id: `tui:unit-${n}`, label: `Unit ${n}`, description: `does thing ${n}; and more detail` });

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pb-whats-new-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

function notice(found: NewUnits, over: Partial<WhatsNewOptions> = {}) {
  let asked = 0;
  const take = (version = "0.46.0") =>
    whatsNewNoticeFor({ dataDir, version, env: {}, main: INSTALLED, find: async () => ((asked += 1), found), ...over });
  return { take, asked: () => asked };
}

describe("what's-new notice", () => {
  it("names the new units and the command once per upgrade, then again after the next one", async () => {
    const n = notice({ units: [unit(1), unit(2)], complete: true });

    const first = await n.take();
    expect(first?.text).toContain("project-brain 0.46.0 has 2 setup units you have not chosen yet");
    expect(first?.text).toContain("- tui:unit-1: Unit 1, does thing 1");
    expect(first?.text).not.toContain("and more detail");
    expect(first?.text).toContain("`project-brain setup --new`");

    // Not marked until the caller commits, i.e. until it was printed.
    expect(await n.take()).not.toBeNull();
    await first!.commit();
    expect(await n.take()).toBeNull();
    expect(await n.take("0.47.0")).not.toBeNull();
  });

  it("lists at most five units, then counts the rest", async () => {
    const text = (await notice({ units: [1, 2, 3, 4, 5, 6, 7].map(unit), complete: true }).take())!.text;
    expect(text).toContain("tui:unit-5");
    expect(text).not.toContain("tui:unit-6");
    expect(text).toContain("+2 more");
  });

  it("with nothing new, marks the version so later prompts skip the probe; a slow probe is retried", async () => {
    const empty = notice({ units: [], complete: true });
    expect(await empty.take()).toBeNull();
    expect(await empty.take()).toBeNull();
    expect(empty.asked()).toBe(1);

    const slow = notice({ units: [], complete: false });
    expect(await slow.take("0.48.0")).toBeNull();
    expect(await slow.take("0.48.0")).toBeNull();
    expect(slow.asked()).toBe(2);
  });

  it("stays silent with PROJECT_BRAIN_WHATS_NEW=0, and from a source checkout", async () => {
    const found = { units: [unit(1)], complete: true };
    expect(await notice(found, { env: { PROJECT_BRAIN_WHATS_NEW: "0" } }).take()).toBeNull();
    expect(await notice(found, { main: "/repo/src/cli.ts" }).take()).toBeNull();
  });

  it("is printed by the prompt hook and marked only after printing", async () => {
    const events: string[] = [];
    await runSuggest(JSON.stringify({ prompt: "please refactor the parser", cwd: "/work/app", session_id: "s1" }), {
      print: (l) => events.push(l),
      pick: async () => [],
      upgradeNotice: async () => null,
      whatsNew: async () => ({ text: "project-brain 0.46.0 has a setup unit", commit: async () => void events.push("commit") }),
    });
    expect(events).toEqual(["project-brain 0.46.0 has a setup unit", "commit"]);
  });
});

describe("findNewUnits", () => {
  it("returns only units the selection never saw and that are not on disk; declined ones never", async () => {
    const ctx = {
      dataDir,
      installed: [],
      selectionPath: join(dataDir, "setup-selection.json"),
      claudeSettingsPath: join(dataDir, "settings.json"),
      routingConfigPath: join(dataDir, "model-routing.json"),
    } as unknown as SetupContext;
    // task-switch: unseen and off (new). search-gate: off but declined. conceptualize: unseen but on (not news).
    await writeFile(join(dataDir, "features.json"), JSON.stringify({ "task-switch": false, "search-gate": false }));
    const unseen = ["feature:task-switch", "feature:conceptualize", "config:mcp-prune-jev"];
    const answered = allUnits(ctx).map((u) => u.id).filter((id) => !unseen.includes(id));
    await writeFile(
      ctx.selectionPath,
      JSON.stringify({ version: 1, updatedAt: "", binaryVersion: "0.44.0", selected: [], declined: answered })
    );

    const found = await findNewUnits(ctx);

    expect(found.complete).toBe(true);
    expect(found.units.map((u) => u.id).sort()).toEqual(["config:mcp-prune-jev", "feature:task-switch"]);
  });

  it("reports nothing without a saved selection", async () => {
    const ctx = { dataDir, installed: [], selectionPath: join(dataDir, "none.json") } as unknown as SetupContext;
    expect(await findNewUnits(ctx)).toEqual({ units: [], complete: true });
  });
});
