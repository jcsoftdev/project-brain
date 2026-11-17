import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  LAZYGIT_THEME_MARKER,
  type LazygitThemePaths,
  applyLazygitTheme,
  lazygitConfigDir,
  lazygitOwnerConfigFiles,
  lazygitThemeOf,
  lazygitThemeState,
  lazygitThemeYaml,
  removeLazygitTheme,
} from "../../src/setup/lazygit-theme.js";
import { lazygitThemeUnit } from "../../src/setup/units-lazygit.js";
import type { SetupContext } from "../../src/setup/units.js";
import { themeById, uiRolesOf } from "../../src/themes/index.js";

const theme = themeById();
const roles = uiRolesOf(theme);

let dir: string;
let paths: LazygitThemePaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-lazygit-theme-"));
  paths = { themeFile: join(dir, ".lazygit.yml"), ownerConfigFiles: [join(dir, "config", "config.yml")] };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeOwnerConfig(text: string) {
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(paths.ownerConfigFiles[0], text);
}

describe("lazygit theme composition", () => {
  it("maps every slot to its role", () => {
    expect(lazygitThemeOf(roles)).toEqual({
      activeBorderColor: [roles.border.focus, "bold"],
      inactiveBorderColor: [roles.border.idle],
      searchingActiveBorderColor: [roles.border.input, "bold"],
      optionsTextColor: [roles.text.hint],
      selectedLineFgColor: ["bold"],
      selectedLineBgColor: [roles.surface.line],
      inactiveViewSelectedLineBgColor: ["bold"],
      cherryPickedCommitFgColor: [roles.text.onAccent],
      cherryPickedCommitBgColor: [roles.accent.pink],
      markedBaseCommitFgColor: [roles.text.onAccent],
      markedBaseCommitBgColor: [roles.accent.yellow],
      unstagedChangesColor: [roles.git.unstaged],
      defaultFgColor: [roles.text.fg],
    });
  });

  it("paints the Dracula composition: purple focus, orange search, pink pick, the current row on the line layer", () => {
    const slots = lazygitThemeOf(roles);
    expect(slots.activeBorderColor[0]).toBe("#bd93f9");
    expect(slots.searchingActiveBorderColor[0]).toBe("#ffb86c");
    expect(slots.cherryPickedCommitBgColor[0]).toBe("#ff79c6");
    expect(slots.unstagedChangesColor[0]).toBe("#ff5555");
    expect(slots.selectedLineBgColor[0]).not.toBe(theme.selection);
    expect(slots.selectedLineBgColor[0]).not.toBe(theme.comment);
    expect(slots.optionsTextColor[0]).not.toBe(theme.comment);
  });

  it("renders valid YAML under gui.theme, behind the marker line", () => {
    const text = lazygitThemeYaml(theme);
    expect(text.split("\n")[0]).toBe(LAZYGIT_THEME_MARKER);
    expect(parse(text)).toEqual({ gui: { theme: lazygitThemeOf(roles) } });
  });
});

describe("lazygit config locations", () => {
  it("follows the platform default, and XDG_CONFIG_HOME when it is absolute", () => {
    expect(lazygitConfigDir("/h", "darwin", undefined)).toBe("/h/Library/Application Support/lazygit");
    expect(lazygitConfigDir("/h", "linux", undefined)).toBe("/h/.config/lazygit");
    expect(lazygitConfigDir("/h", "linux", "/x")).toBe("/x/lazygit");
    expect(lazygitConfigDir("/h", "linux", "rel")).toBe("/h/.config/lazygit");
  });

  it("reads the LG_CONFIG_FILE list when set, else config.yml", () => {
    expect(lazygitOwnerConfigFiles("/c", undefined)).toEqual(["/c/config.yml"]);
    expect(lazygitOwnerConfigFiles("/c", "/a.yml, /b.yml,")).toEqual(["/a.yml", "/b.yml"]);
  });
});

describe("lazygit theme state", () => {
  it("is absent, then current after apply, and apply is idempotent", async () => {
    expect(await lazygitThemeState(paths, theme)).toBe("absent");
    await applyLazygitTheme(paths, theme);
    expect(await readFile(paths.themeFile, "utf8")).toBe(lazygitThemeYaml(theme));
    expect(await lazygitThemeState(paths, theme)).toBe("current");
    await applyLazygitTheme(paths, theme);
    expect(await readFile(paths.themeFile, "utf8")).toBe(lazygitThemeYaml(theme));
  });

  it("is stale when the managed file drifted, and apply restores it", async () => {
    await writeFile(paths.themeFile, `${LAZYGIT_THEME_MARKER}\ngui: {}\n`);
    expect(await lazygitThemeState(paths, theme)).toBe("stale");
    await applyLazygitTheme(paths, theme);
    expect(await lazygitThemeState(paths, theme)).toBe("current");
  });

  it("is foreign for the owner's own .lazygit.yml, which apply and remove leave alone", async () => {
    await writeFile(paths.themeFile, "git:\n  autoFetch: false\n");
    expect(await lazygitThemeState(paths, theme)).toBe("foreign");
    await applyLazygitTheme(paths, theme);
    await removeLazygitTheme(paths);
    expect(await readFile(paths.themeFile, "utf8")).toBe("git:\n  autoFetch: false\n");
  });

  it.each([
    ["gui.theme", "gui:\n  theme:\n    activeBorderColor:\n      - green\n"],
    ["gui.darkTheme", "gui:\n  darkTheme:\n    selectedLineBgColor:\n      - blue\n"],
    ["gui.lightTheme", "gui:\n  lightTheme:\n    optionsTextColor:\n      - blue\n"],
    ["an unparseable config", "gui: [\n"],
  ])("is foreign when the owner's config sets %s, and apply writes nothing", async (_, config) => {
    await writeOwnerConfig(config);
    expect(await lazygitThemeState(paths, theme)).toBe("foreign");
    await applyLazygitTheme(paths, theme);
    expect(existsSync(paths.themeFile)).toBe(false);
  });

  it("stays clear of owner settings it does not write", async () => {
    await writeOwnerConfig("gui:\n  nerdFontsVersion: '3'\n  theme:\n    authorColors:\n      a: '#00ff00'\n");
    expect(await lazygitThemeState(paths, theme)).toBe("absent");
  });

  it("remove deletes exactly the managed file and never the owner's config", async () => {
    await writeOwnerConfig("gui:\n  showIcons: true\n");
    await applyLazygitTheme(paths, theme);
    await removeLazygitTheme(paths);
    expect(existsSync(paths.themeFile)).toBe(false);
    expect(await readFile(paths.ownerConfigFiles[0], "utf8")).toBe("gui:\n  showIcons: true\n");
    expect(await lazygitThemeState(paths, theme)).toBe("absent");
  });
});

describe("terminal:lazygit-theme unit", () => {
  const ctxOf = (home: string) =>
    ({ claudeSettingsPath: join(home, ".claude", "settings.json"), platform: "darwin" }) as unknown as SetupContext;
  const unit = lazygitThemeUnit({ which: () => "/usr/bin/lazygit", printConfigDir: () => null });

  it("is an opt-in Terminal tools unit", () => {
    expect(unit.id).toBe("terminal:lazygit-theme");
    expect(unit.group).toBe("Terminal tools");
    expect(unit.defaultSelected).toBe(false);
  });

  it("is unavailable without lazygit on PATH and writes nothing", async () => {
    const missing = lazygitThemeUnit({ which: () => null });
    expect(await missing.inspect(ctxOf(dir))).toBe("unavailable");
    await missing.apply(ctxOf(dir));
    expect(existsSync(join(dir, ".lazygit.yml"))).toBe(false);
  });

  it("writes ~/.lazygit.yml, reads the owner's config from the platform dir, and removes only its file", async () => {
    const ownerConfig = join(dir, "Library", "Application Support", "lazygit", "config.yml");
    await mkdir(join(ownerConfig, ".."), { recursive: true });
    await writeFile(ownerConfig, "");
    expect(await unit.inspect(ctxOf(dir))).toBe("absent");
    await unit.apply(ctxOf(dir));
    expect(await unit.inspect(ctxOf(dir))).toBe("current");
    expect(await readFile(join(dir, ".lazygit.yml"), "utf8")).toBe(lazygitThemeYaml(theme));
    await writeFile(ownerConfig, "gui:\n  theme:\n    activeBorderColor: [green]\n");
    expect(await unit.inspect(ctxOf(dir))).toBe("foreign");
    await unit.remove(ctxOf(dir));
    expect(existsSync(join(dir, ".lazygit.yml"))).toBe(false);
    expect(await readFile(ownerConfig, "utf8")).toBe("gui:\n  theme:\n    activeBorderColor: [green]\n");
  });
});

const lazygitBin = Bun.which("lazygit");

describe.skipIf(!lazygitBin)("the installed lazygit", () => {
  it("accepts every key the theme writes", () => {
    const printed = Bun.spawnSync([lazygitBin as string, "--config"], { stdout: "pipe" }).stdout.toString();
    const accepted = Object.keys((parse(printed) as { gui: { theme: Record<string, unknown> } }).gui.theme);
    expect(accepted).toEqual(expect.arrayContaining(Object.keys(lazygitThemeOf(roles))));
  });

  const tmuxBin = Bun.which("tmux");
  it.skipIf(!tmuxBin)(
    "paints a repository under home with the managed .lazygit.yml",
    async () => {
      const home = join(dir, "home");
      const repo = join(home, "work", "repo");
      await mkdir(repo, { recursive: true });
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, env: { HOME: home, PATH: process.env.PATH } });
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "init");
      await writeFile(join(repo, "changed.txt"), "x\n");
      await applyLazygitTheme({ themeFile: join(home, ".lazygit.yml"), ownerConfigFiles: [] }, theme);
      const configDir = join(home, "lgconfig");
      await mkdir(configDir, { recursive: true });
      const version = /version=([\d.]+)/.exec(Bun.spawnSync([lazygitBin as string, "--version"]).stdout.toString())?.[1];
      await writeFile(join(configDir, "state.yml"), `startuppopupversion: 5\ndidshowhunkstaginghint: true\nlastversion: ${version}\n`);

      const socket = join(dir, "tmux.sock");
      const env = { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", COLORTERM: "truecolor", CONFIG_DIR: configDir };
      const tmux = (...args: string[]) => Bun.spawnSync([tmuxBin as string, "-S", socket, "-f", "/dev/null", ...args], { env, stdout: "pipe" });
      const sgr = (hex: string, layer: 38 | 48) =>
        `\x1b[${layer};2;${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";")}m`;
      try {
        tmux("new-session", "-d", "-x", "120", "-y", "30", "-c", repo, `${lazygitBin} -p ${repo}`);
        let screen = "";
        for (let attempt = 0; attempt < 40 && !screen.includes(sgr(roles.surface.line, 48)); attempt++) {
          await Bun.sleep(250);
          screen = tmux("capture-pane", "-e", "-p").stdout.toString();
        }
        expect(screen).toContain(sgr(roles.border.focus, 38));
        expect(screen).toContain(sgr(roles.surface.line, 48));
        expect(screen).toContain(sgr(roles.git.unstaged, 38));
        expect(screen).toContain(sgr(roles.border.idle, 38));
        expect(screen).toContain(sgr(roles.text.hint, 38));
      } finally {
        tmux("kill-server");
      }
    },
    20_000
  );
});
