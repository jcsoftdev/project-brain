import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { allUnits, type SetupContext } from "../../src/setup/units.js";
import {
  TERMINAL_THEME_BEGIN,
  TERMINAL_THEME_END,
  applyTerminalTheme,
  readTerminalConfig,
  removeTerminalTheme,
  TERMINAL_THEME_BLOCK,
  ghosttyConfigPath,
  terminalThemeState,
  withTerminalTheme,
  withoutTerminalTheme,
} from "../../src/setup/terminal-theme.js";
import { themeById } from "../../src/themes/index.js";
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
    const theme = themeById("dracula");
    for (const hex of [theme.background, theme.foreground, theme.selection, theme.comment, ...Object.values(theme.accents)]) {
      expect(pane).toContain(`'${hex}'`);
    }
  });

  it("makes cells with their own background (tabs, pills, diff rows) as translucent as the rest", () => {
    expect(TERMINAL_THEME_BLOCK).toContain("background-opacity-cells = true");
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

describe("terminal theme block: what a user's file can throw at it", () => {
  const LONE_BEGIN = `font-size = 14\n${TERMINAL_THEME_BEGIN}\nfont-family = Iosevka\nkeybind = a=b\n`;

  it("never guesses where an unpaired marker ends: the file is foreign and nothing is deleted", () => {
    expect(terminalThemeState(LONE_BEGIN)).toBe("foreign");
    expect(withTerminalTheme(LONE_BEGIN)).toBe(LONE_BEGIN);
    expect(withoutTerminalTheme(LONE_BEGIN)).toBe(LONE_BEGIN);
    expect(terminalThemeState(`a = 1\n${TERMINAL_THEME_END}\n`)).toBe("foreign");
    expect(terminalThemeState(`${TERMINAL_THEME_BEGIN}\n${TERMINAL_THEME_BEGIN}\n${TERMINAL_THEME_END}\n`)).toBe("foreign");
  });

  it("collapses duplicated blocks into one, and removes every copy", () => {
    const twice = `${TERMINAL_THEME_BLOCK}\n\nfont-size = 14\n\n${TERMINAL_THEME_BLOCK}\n`;
    expect(terminalThemeState(twice)).toBe("stale");
    const healed = withTerminalTheme(twice);
    expect(healed.split(TERMINAL_THEME_BEGIN).length - 1).toBe(1);
    expect(healed).toContain("font-size = 14");
    expect(withoutTerminalTheme(twice)).toBe("font-size = 14\n");
  });

  it("keeps a CRLF file CRLF and still recognises its block", () => {
    const crlf = "font-size = 14\r\n";
    const applied = withTerminalTheme(crlf);
    expect(applied.replace(/\r\n/g, "")).not.toContain("\n");
    expect(terminalThemeState(applied)).toBe("current");
    expect(withoutTerminalTheme(applied)).toBe(crlf);
  });

  it("leaves no extra blank lines when the block sat in the middle of the file", () => {
    const middle = `a = 1\n\n${TERMINAL_THEME_BLOCK}\n\nb = 2\n`;
    expect(withoutTerminalTheme(middle)).toBe("a = 1\n\nb = 2\n");
  });

  it("reads a missing file as empty but refuses to treat any other read failure as empty", async () => {
    expect(await readTerminalConfig(join(home, "nope", "config"))).toBe("");
    const asDirectory = join(home, "dir-as-config");
    await mkdir(asDirectory, { recursive: true });
    await expect(readTerminalConfig(asDirectory)).rejects.toThrow();
    await expect(removeTerminalTheme(asDirectory)).rejects.toThrow();
  });

  it("does not touch a foreign file on apply or remove", async () => {
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, LONE_BEGIN);
    await applyTerminalTheme(config);
    await removeTerminalTheme(config);
    expect(await readFile(config, "utf8")).toBe(LONE_BEGIN);
  });

  it("writes through a symlinked config instead of replacing the link", async () => {
    const real = join(home, "dotfiles", "ghostty");
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, "font-size = 14\n");
    await mkdir(dirname(config), { recursive: true });
    await symlink(real, config);
    await applyTerminalTheme(config);
    expect(terminalThemeState(await readFile(real, "utf8"))).toBe("current");
    await removeTerminalTheme(config);
    expect(await readFile(real, "utf8")).toBe("font-size = 14\n");
  });
});
