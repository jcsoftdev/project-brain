import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SetupContext } from "../../src/setup/units.js";
import { tmuxThemeUnit } from "../../src/setup/units-tmux.js";
import {
  TMUX_THEME_BEGIN,
  TMUX_THEME_END,
  applyTmuxTheme,
  removeTmuxTheme,
  tmuxConfigPath,
  tmuxOptionsOf,
  tmuxThemeBlockOf,
  tmuxThemeState,
} from "../../src/setup/tmux-theme.js";
import { themeById } from "../../src/themes/index.js";
import { uiRolesOf } from "../../src/themes/roles.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pb-tmux-theme-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const found = () => "/usr/bin/tmux";
const missing = () => null;
const theme = themeById();
const roles = uiRolesOf(theme);
const options = () => new Map(tmuxOptionsOf(roles));

const ctx = (): SetupContext => ({ claudeSettingsPath: join(home, ".claude", "settings.json") }) as unknown as SetupContext;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("tmux options from the theme roles", () => {
  it("paints every colour as #rrggbb or default", () => {
    for (const [, value] of tmuxOptionsOf(roles)) {
      for (const colour of value.match(/(?:fg|bg)=[^,\]]+/g) ?? []) expect(colour).toMatch(/^(fg|bg)=(#[0-9a-f]{6}|default)$/);
    }
    for (const name of ["clock-mode-colour", "display-panes-active-colour", "display-panes-colour"]) {
      expect(options().get(name)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("follows the composition: translucent bar, comment idle borders, purple focus, base text on pills", () => {
    const o = options();
    expect(o.get("status-style")).toBe(`fg=${roles.text.muted},bg=default`);
    expect(o.get("status-right-style")).toBe(`fg=${roles.text.hint},bg=default`);
    expect(o.get("window-status-style")).toBe(`fg=${roles.text.muted},bg=default`);
    expect(o.get("window-status-current-style")).toBe(`fg=${roles.text.onAccent},bg=${roles.accent.purple},bold`);
    expect(o.get("pane-border-style")).toBe(`fg=${roles.text.comment},bg=default`);
    expect(o.get("pane-active-border-style")).toBe(`fg=${roles.accent.purple},bg=default`);
    expect(o.get("message-style")).toBe(`fg=${roles.text.fg},bg=${roles.surface.float}`);
    expect(o.get("mode-style")).toBe(`fg=${roles.text.fg},bg=${roles.surface.selection}`);
    expect(o.get("copy-mode-current-match-style")).toBe(`fg=${roles.text.onAccent},bg=${roles.accent.orange}`);
    expect(o.get("status-left")).toContain(`#{?client_prefix,#[bg=${roles.accent.orange}],}`);
  });

  it("is the Dracula composition on the owner's background", () => {
    const o = options();
    expect(o.get("pane-border-style")).toBe("fg=#6272a4,bg=default");
    expect(o.get("pane-active-border-style")).toBe("fg=#bd93f9,bg=default");
    expect(o.get("window-status-current-style")).toBe("fg=#17141d,bg=#bd93f9,bold");
    expect(o.get("message-style")).toBe("fg=#f8f8f2,bg=#2e2e3c");
  });

  it("writes one quoted set line per option between the markers", () => {
    const lines = tmuxThemeBlockOf(theme).split("\n");
    expect(lines[0]).toBe(TMUX_THEME_BEGIN);
    expect(lines.at(-1)).toBe(TMUX_THEME_END);
    expect(lines.filter((line) => line.startsWith("set -g ")).length).toBe(tmuxOptionsOf(roles).length);
    expect(lines).toContain('set -g pane-active-border-style "fg=#bd93f9,bg=default"');
  });
});

describe("which tmux config gets the block", () => {
  it("creates ~/.config/tmux/tmux.conf when there is none", () => {
    expect(tmuxConfigPath(home)).toBe(join(home, ".config", "tmux", "tmux.conf"));
  });

  it("uses XDG_CONFIG_HOME for a new file when it is set", () => {
    expect(tmuxConfigPath(home, join(home, "xdg"))).toBe(join(home, "xdg", "tmux", "tmux.conf"));
  });

  it("uses ~/.tmux.conf when it is the only one", async () => {
    await write(join(home, ".tmux.conf"), "set -g mouse on\n");
    expect(tmuxConfigPath(home)).toBe(join(home, ".tmux.conf"));
  });

  it("uses the last one tmux loads when several exist", async () => {
    await write(join(home, ".tmux.conf"), "set -g mouse on\n");
    await write(join(home, ".config", "tmux", "tmux.conf"), "set -g mouse off\n");
    expect(tmuxConfigPath(home)).toBe(join(home, ".config", "tmux", "tmux.conf"));
  });
});

describe("tmux theme block in the file", () => {
  const userConfig = "set -g mouse on\nset -g @plugin 'tmux-plugins/tpm'\n\nrun '~/.tmux/plugins/tpm/tpm'\n";

  it("is unavailable without tmux, whatever the file holds", async () => {
    const path = join(home, ".tmux.conf");
    await applyTmuxTheme(path, theme);
    expect(await tmuxThemeState(path, theme, missing)).toBe("unavailable");
  });

  it("goes absent, current, stale and back to absent", async () => {
    const path = join(home, ".tmux.conf");
    await write(path, userConfig);
    expect(await tmuxThemeState(path, theme, found)).toBe("absent");
    await applyTmuxTheme(path, theme);
    expect(await tmuxThemeState(path, theme, found)).toBe("current");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("#bd93f9", "#000000"));
    expect(await tmuxThemeState(path, theme, found)).toBe("stale");
    await applyTmuxTheme(path, theme);
    expect(await readFile(path, "utf8")).toBe(text);
    await removeTmuxTheme(path);
    expect(await tmuxThemeState(path, theme, found)).toBe("absent");
  });

  it("goes after everything the user wrote, the TPM run line included", async () => {
    const path = join(home, ".tmux.conf");
    await write(path, userConfig);
    await applyTmuxTheme(path, theme);
    const text = await readFile(path, "utf8");
    expect(text.startsWith(userConfig)).toBe(true);
    expect(text.trimEnd().endsWith(TMUX_THEME_END)).toBe(true);
  });

  it("is idempotent", async () => {
    const path = join(home, ".tmux.conf");
    await write(path, userConfig);
    await applyTmuxTheme(path, theme);
    const once = await readFile(path, "utf8");
    await applyTmuxTheme(path, theme);
    expect(await readFile(path, "utf8")).toBe(once);
  });

  it("removes exactly the block and leaves the rest byte-identical", async () => {
    const path = join(home, ".tmux.conf");
    await write(path, userConfig);
    await applyTmuxTheme(path, theme);
    await removeTmuxTheme(path);
    expect(await readFile(path, "utf8")).toBe(userConfig);
  });

  it("leaves a file with an unpaired marker alone and reports it foreign", async () => {
    const path = join(home, ".tmux.conf");
    const broken = `${userConfig}${TMUX_THEME_BEGIN}\nset -g mouse off\n`;
    await write(path, broken);
    expect(await tmuxThemeState(path, theme, found)).toBe("foreign");
    await applyTmuxTheme(path, theme);
    await removeTmuxTheme(path);
    expect(await readFile(path, "utf8")).toBe(broken);
  });

  it("does not create a file to remove nothing from", async () => {
    const path = join(home, ".config", "tmux", "tmux.conf");
    await removeTmuxTheme(path);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe("tmux theme unit", () => {
  it("is opt-in under Terminal tools", () => {
    const unit = tmuxThemeUnit(found);
    expect(unit.id).toBe("terminal:tmux-theme");
    expect(unit.group).toBe("Terminal tools");
    expect(unit.defaultSelected).toBe(false);
  });

  it("is unavailable when tmux is not on PATH", async () => {
    expect(await tmuxThemeUnit(missing).inspect(ctx())).toBe("unavailable");
  });

  it("writes the block into the home it is given and removes it", async () => {
    const unit = tmuxThemeUnit(found);
    const path = join(home, ".config", "tmux", "tmux.conf");
    const log = console.log;
    const printed: string[] = [];
    console.log = (line: string) => printed.push(line);
    try {
      await unit.apply(ctx());
    } finally {
      console.log = log;
    }
    expect(await unit.inspect(ctx())).toBe("current");
    expect(printed).toEqual([`tmux theme written to ${path}; a running tmux picks it up with: tmux source-file ${path}`]);
    await unit.remove(ctx());
    expect(await readFile(path, "utf8")).toBe("");
    expect(await unit.inspect(ctx())).toBe("absent");
  });
});

describe.skipIf(!Bun.which("tmux"))("the real tmux reading the block", () => {
  const tmux = (...args: string[]) => {
    const run = Bun.spawnSync(["tmux", "-S", join(home, "pb-test.sock"), ...args], {
      env: { ...process.env, TMUX: "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    });
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
  };

  it("takes every option with the value the block sets", async () => {
    const conf = join(home, "theme.conf");
    await write(conf, `${tmuxThemeBlockOf(theme)}\n`);
    try {
      const start = tmux("-f", conf, "new-session", "-d", "-s", "pb");
      expect(start.err).toBe("");
      expect(start.code).toBe(0);
      const shown = `${tmux("show-options", "-g").out}\n${tmux("show-window-options", "-g").out}\n${tmux("show-options", "-s").out}`;
      for (const [name, value] of tmuxOptionsOf(roles)) {
        const line = shown.split("\n").find((one) => one.startsWith(`${name} `));
        expect(line, name).toBeDefined();
        const actual = line!.slice(name.length + 1).replace(/^"(.*)"$|^'(.*)'$/, "$1$2").replace(/\\"/g, '"');
        expect(actual, name).toBe(value);
      }
      const left = tmux("display-message", "-p", "-t", "pb", "#{E:status-left}");
      expect(left.out).toContain(`#[fg=${roles.text.onAccent},bg=${roles.accent.purple},bold] pb `);
    } finally {
      tmux("kill-server");
    }
  });
});
