import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupContext } from "../../src/setup/units.js";
import { fzfThemeUnit } from "../../src/setup/units-fzf.js";
import {
  FZF_THEME_BEGIN,
  FZF_THEME_END,
  applyFzfTheme,
  fzfColorOptionOf,
  fzfColorsOf,
  fzfRcPath,
  fzfThemeBlockOf,
  fzfThemeState,
  fzfThemeStateOf,
  removeFzfTheme,
  withFzfTheme,
  withoutFzfTheme,
} from "../../src/setup/fzf-theme.js";
import { themeById, uiRolesOf } from "../../src/themes/index.js";

const theme = themeById();
const roles = uiRolesOf(theme);
const installed = () => "/usr/bin/fzf";
const missing = () => null;

let home: string;
let rc: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pb-fzf-theme-"));
  rc = join(home, ".zshrc");
});
afterEach(() => rm(home, { recursive: true, force: true }));

const ctx = (): SetupContext => ({ dataDir: join(home, "data"), installed: [], claudeSettingsPath: join(home, ".claude", "settings.json") }) as unknown as SetupContext;

describe("fzf colours", () => {
  it("paints the Tokyo Night + Dracula composition slot by slot", () => {
    expect(Object.fromEntries(fzfColorsOf(theme))).toEqual({
      fg: "#f8f8f2",
      bg: "-1",
      gutter: "-1",
      hl: "#8be9fd",
      "fg+": "#f8f8f2:bold",
      "bg+": "#2b2b38",
      "hl+": "#8be9fd",
      query: "#f8f8f2:regular",
      info: "#97a1bf",
      border: "#6272a4",
      "list-border": "#6272a4",
      "preview-border": "#6272a4",
      "input-border": "#ffb86c",
      separator: "#6272a4",
      scrollbar: "#6272a4",
      label: "#bd93f9:bold",
      prompt: "#ffb86c",
      pointer: "#ff79c6",
      marker: "#ff79c6",
      spinner: "#ffb86c",
      header: "#97a1bf",
    });
  });

  it("comes from the roles: the current row is the line layer, never the selection", () => {
    const colors = Object.fromEntries(fzfColorsOf(theme));
    expect(colors["bg+"]).toBe(roles.surface.line);
    expect(colors["bg+"]).not.toBe(roles.surface.selection);
    expect(colors.header).not.toBe(roles.text.comment);
    expect(colors.info).not.toBe(roles.text.comment);
  });

  it("passes only #rrggbb colours, the terminal default being the one exception", () => {
    for (const [slot, value] of fzfColorsOf(theme)) {
      const color = value.split(":")[0]!;
      if (color === "-1") expect(["bg", "gutter"]).toContain(slot);
      else expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("is one --color option with no character a double-quoted shell string would expand", () => {
    const option = fzfColorOptionOf(theme);
    expect(option.startsWith("--color=fg:#f8f8f2,")).toBe(true);
    expect(option).not.toMatch(/[\s"$`\\]/);
  });
});

describe("fzf theme block", () => {
  it("appends to the user's options and does nothing without fzf", () => {
    expect(fzfThemeBlockOf(theme).split("\n")).toEqual([
      FZF_THEME_BEGIN,
      `# ${theme.label}`,
      "if command -v fzf >/dev/null 2>&1; then",
      `  export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPTS ${fzfColorOptionOf(theme)}"`,
      "fi",
      FZF_THEME_END,
    ]);
  });

  it("goes last, once, and comes out leaving the rc byte-identical", () => {
    const original = "export PATH=$HOME/bin:$PATH\nexport FZF_DEFAULT_OPTS='--layout=reverse'\n";
    const themed = withFzfTheme(original);
    expect(themed.startsWith(original)).toBe(true);
    expect(themed.trimEnd().endsWith(FZF_THEME_END)).toBe(true);
    expect(withFzfTheme(themed)).toBe(themed);
    expect(withoutFzfTheme(themed)).toBe(original);
  });

  it("reads absent, current, stale and foreign", () => {
    expect(fzfThemeStateOf("")).toBe("absent");
    expect(fzfThemeStateOf(withFzfTheme("alias l=ls\n"))).toBe("current");
    expect(fzfThemeStateOf(`${FZF_THEME_BEGIN}\nexport FZF_DEFAULT_OPTS=old\n${FZF_THEME_END}\n`)).toBe("stale");
    expect(fzfThemeStateOf(`alias l=ls\n${FZF_THEME_BEGIN}\nexport X=1\n`)).toBe("foreign");
  });
});

describe("fzf rc", () => {
  it("is ~/.zshrc for zsh (ZDOTDIR when set), ~/.bashrc for bash, none for other shells", () => {
    expect(fzfRcPath("/h", "/opt/homebrew/bin/zsh")).toBe("/h/.zshrc");
    expect(fzfRcPath("/h", "/bin/zsh", "/h/.config/zsh")).toBe("/h/.config/zsh/.zshrc");
    expect(fzfRcPath("/h", "/bin/bash", "/h/.config/zsh")).toBe("/h/.bashrc");
    expect(fzfRcPath("/h", "/usr/local/bin/fish")).toBeNull();
    expect(fzfRcPath("/h", undefined)).toBeNull();
  });

  it("is unavailable without fzf or without a supported shell, and then left alone", async () => {
    expect(await fzfThemeState({ rcPath: rc, which: missing })).toBe("unavailable");
    expect(await fzfThemeState({ rcPath: null, which: installed })).toBe("unavailable");
    await applyFzfTheme({ rcPath: rc, which: missing });
    expect(existsSync(rc)).toBe(false);
  });

  it("applies idempotently and removes exactly the block", async () => {
    const original = "# mine\nsetopt autocd\n\nalias g=git";
    await writeFile(rc, original);
    expect(await fzfThemeState({ rcPath: rc, which: installed })).toBe("absent");
    await applyFzfTheme({ rcPath: rc, which: installed });
    const once = await readFile(rc, "utf8");
    expect(await fzfThemeState({ rcPath: rc, which: installed })).toBe("current");
    await applyFzfTheme({ rcPath: rc, which: installed });
    expect(await readFile(rc, "utf8")).toBe(once);
    await removeFzfTheme({ rcPath: rc });
    expect(await readFile(rc, "utf8")).toBe(`${original}\n`);
  });

  it("never touches an rc with an unpaired marker", async () => {
    const broken = `alias g=git\n${FZF_THEME_BEGIN}\nexport FOO=1\n`;
    await writeFile(rc, broken);
    expect(await fzfThemeState({ rcPath: rc, which: installed })).toBe("foreign");
    await applyFzfTheme({ rcPath: rc, which: installed });
    await removeFzfTheme({ rcPath: rc });
    expect(await readFile(rc, "utf8")).toBe(broken);
  });

  it("removing from a missing rc creates nothing", async () => {
    await removeFzfTheme({ rcPath: rc });
    expect(existsSync(rc)).toBe(false);
  });
});

describe("fzf theme unit", () => {
  it("is an opt-in Terminal tools unit", () => {
    const unit = fzfThemeUnit();
    expect(unit.id).toBe("terminal:fzf-theme");
    expect(unit.group).toBe("Terminal tools");
    expect(unit.defaultSelected).toBe(false);
  });

  it("writes the shell's rc under the context's home and takes it back out", async () => {
    const zsh = fzfThemeUnit({ which: installed, shell: "/bin/zsh" });
    expect(await zsh.inspect(ctx())).toBe("absent");
    await zsh.apply(ctx());
    expect(await zsh.inspect(ctx())).toBe("current");
    await zsh.remove(ctx());
    expect(await readFile(rc, "utf8")).toBe("");

    const bash = fzfThemeUnit({ which: installed, shell: "/bin/bash" });
    await bash.apply(ctx());
    expect(await readFile(join(home, ".bashrc"), "utf8")).toContain(fzfColorOptionOf(theme));
  });

  it("reports unavailable when fzf is not on PATH", async () => {
    expect(await fzfThemeUnit({ which: missing, shell: "/bin/zsh" }).inspect(ctx())).toBe("unavailable");
  });
});

describe.skipIf(!Bun.which("fzf"))("the real fzf", () => {
  const fzf = Bun.which("fzf")!;
  const isolated = (opts: Record<string, string>) => ({ HOME: home, PATH: process.env.PATH ?? "", TERM: "dumb", ...opts });
  const filter = (env: Record<string, string>) =>
    Bun.spawnSync([fzf, "--filter", "x"], { env, stdin: new TextEncoder().encode("x\ny\n"), stdout: "pipe", stderr: "pipe" });

  it("accepts the generated --color option", () => {
    const run = filter(isolated({ FZF_DEFAULT_OPTS: fzfColorOptionOf(theme) }));
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  it("rejects a bad colour, so the check above means something", () => {
    expect(filter(isolated({ FZF_DEFAULT_OPTS: "--color=bg+:#zzzzzz" })).exitCode).toBe(2);
  });

  for (const shell of ["zsh", "bash"].filter((one) => Bun.which(one))) {
    it(`gets the theme appended to the user's options when ${shell} reads the block`, async () => {
      await writeFile(rc, withFzfTheme("export FZF_DEFAULT_OPTS='--layout=reverse'\n"));
      const script = `. "${rc}"; printf '%s' "$FZF_DEFAULT_OPTS"; printf 'x\\n' | fzf --filter x >/dev/null`;
      const run = Bun.spawnSync([Bun.which(shell)!, "-c", script], { env: isolated({}), stdout: "pipe", stderr: "pipe" });
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(`--layout=reverse ${fzfColorOptionOf(theme)}`);
    });
  }
});
