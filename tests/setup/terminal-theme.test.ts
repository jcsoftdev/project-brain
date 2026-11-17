import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allUnits, type SetupContext } from "../../src/setup/units.js";
import {
  DRACULA_TERMINAL,
  TERMINAL_THEME_BLOCK,
  ghosttyConfigPath,
  terminalThemeState,
  withTerminalTheme,
  withoutTerminalTheme,
} from "../../src/setup/terminal-theme.js";
// @ts-expect-error Bun's text attribute embeds the .tsx as a string.
import registerTsx from "../../templates/claude-tui/activity-pane/hooks/register.tsx" with { type: "text" };

let home: string;
let config: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pb-terminal-theme-"));
  config = join(home, ".config", "ghostty", "config.ghostty");
});
afterEach(() => rm(home, { recursive: true, force: true }));

const ctx = (): SetupContext =>
  ({ dataDir: join(home, "data"), installed: [], claudeSettingsPath: join(home, ".claude", "settings.json"), routingConfigPath: join(home, "none.json") }) as unknown as SetupContext;
const unit = () => allUnits(ctx()).find((one) => one.id === "tui:terminal-theme")!;

describe("terminal theme block", () => {
  it("is Dracula, with the opacity and blur the pane is drawn for", () => {
    expect(TERMINAL_THEME_BLOCK).toContain("background = 17141d");
    expect(TERMINAL_THEME_BLOCK).toContain("foreground = f8f8f2");
    expect(TERMINAL_THEME_BLOCK).toContain("palette = 5=#ff79c6");
    expect(TERMINAL_THEME_BLOCK).toContain("background-opacity = 0.88");
    expect(TERMINAL_THEME_BLOCK).toContain("background-blur = 20");
  });

  it("uses the same colours as the activity pane's palette", () => {
    const pane = registerTsx as string;
    for (const hex of [DRACULA_TERMINAL.background, DRACULA_TERMINAL.foreground, DRACULA_TERMINAL.selection, ...DRACULA_TERMINAL.palette.slice(1, 7)]) {
      expect(pane).toContain(`#${hex}`);
    }
  });

  it("goes at the end and leaves everything the user wrote untouched", () => {
    const mine = "font-size = 14\nbackground = 17131f\n";
    const out = withTerminalTheme(mine);
    expect(out.startsWith("font-size = 14\nbackground = 17131f\n")).toBe(true);
    expect(out.indexOf("background = 17141d")).toBeGreaterThan(out.indexOf("background = 17131f"));
    expect(terminalThemeState(out)).toBe("current");
  });

  it("is idempotent, and removing it restores the file byte for byte", () => {
    const mine = "font-size = 14\nbackground = 17131f\n";
    expect(withTerminalTheme(withTerminalTheme(mine))).toBe(withTerminalTheme(mine));
    expect(withoutTerminalTheme(withTerminalTheme(mine))).toBe(mine);
    expect(withoutTerminalTheme(withTerminalTheme(""))).toBe("");
  });

  it("calls a block with other contents stale", () => {
    expect(terminalThemeState(withTerminalTheme("").replace("0.88", "0.5"))).toBe("stale");
    expect(terminalThemeState("font-size = 14\n")).toBe("absent");
  });
});

describe("ghosttyConfigPath", () => {
  it("defaults to Application Support on macOS and ~/.config elsewhere", () => {
    expect(ghosttyConfigPath("/h", "darwin")).toBe("/h/Library/Application Support/com.mitchellh.ghostty/config.ghostty");
    expect(ghosttyConfigPath("/h", "linux")).toBe("/h/.config/ghostty/config.ghostty");
  });
});

describe("tui:terminal-theme unit", () => {
  it("is off by default and writes only its block into a config that already exists", async () => {
    expect(unit().defaultSelected).toBe(false);
    const path = ghosttyConfigPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "font-size = 14\n");
    expect(await unit().inspect(ctx())).toBe("absent");
    await unit().apply(ctx());
    expect(await unit().inspect(ctx())).toBe("current");
    expect(await readFile(path, "utf8")).toContain("font-size = 14");
    await unit().remove(ctx());
    expect(await readFile(path, "utf8")).toBe("font-size = 14\n");
    expect(await unit().inspect(ctx())).toBe("absent");
  });
});
