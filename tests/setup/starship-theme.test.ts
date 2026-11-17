import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SetupContext } from "../../src/setup/units.js";
import { starshipThemeUnit } from "../../src/setup/units-starship.js";
import {
  STARSHIP_PALETTE_MARKERS,
  STARSHIP_SELECT_MARKERS,
  applyStarshipTheme,
  removeStarshipTheme,
  starshipConfigPath,
  starshipPaletteColours,
  starshipPaletteName,
  starshipThemeState,
  starshipThemeStateOf,
  withStarshipTheme,
  withoutStarshipTheme,
} from "../../src/setup/starship-theme.js";
import { themeById } from "../../src/themes/index.js";

const theme = themeById("dracula");
const installed = () => "/usr/local/bin/starship";
const missing = () => null;

const OWNER_WITH_TABLES = [
  "add_newline = false",
  'format = "$directory$git_branch$character"',
  "",
  "[directory]",
  'style = "bold path"',
  "",
  "[character]",
  'success_symbol = "[❯](bold green)"',
  "",
].join("\n");
const COMMENT_HEADER = "# my starship config\n# nothing else yet\n";
const CRLF = "add_newline = true\r\n\r\n[git_branch]\r\nstyle = \"bold pink\"\r\n";
const OWN_PALETTE = 'palette = "mine"\n\n[palettes.mine]\nred = "#ff0000"\n';

const parse = (text: string) => Bun.TOML.parse(text) as Record<string, any>;

describe("starship palette generator", () => {
  it("paints the composition's roles from the abstract theme", () => {
    expect(starshipPaletteColours(theme)).toEqual({
      background: "#17141d",
      foreground: "#f8f8f2",
      selection: "#44475a",
      comment: "#6272a4",
      red: "#ff5555",
      orange: "#ffb86c",
      yellow: "#f1fa8c",
      green: "#50fa7b",
      cyan: "#8be9fd",
      purple: "#bd93f9",
      pink: "#ff79c6",
      muted: "#97a1bf",
      hint: expect.stringMatching(/^#[0-9a-f]{6}$/),
      path: "#bd93f9",
      line: "#2b2b38",
      error: "#ff5555",
      warning: "#ffb86c",
      info: "#8be9fd",
      progress: "#ffb86c",
      success: "#50fa7b",
      git_added: "#50fa7b",
      git_changed: "#ffb86c",
      git_deleted: "#ff5555",
      git_dirty: "#ff5555",
      branch: "#ff79c6",
      vim_normal: "#bd93f9",
    });
  });

  it("selects the palette at the top level and defines it as a table starship can read", () => {
    const out = parse(withStarshipTheme("", theme));
    expect(out.palette).toBe(starshipPaletteName(theme));
    expect(out.palettes[starshipPaletteName(theme)]).toEqual(starshipPaletteColours(theme));
  });
});

describe("starship config file stays valid TOML", () => {
  const cases: [string, string][] = [
    ["an empty file", ""],
    ["a file with tables", OWNER_WITH_TABLES],
    ["a comment-only file", COMMENT_HEADER],
    ["a CRLF file", CRLF],
  ];
  for (const [name, owner] of cases) {
    it(`for ${name}: palette stays top-level, the owner's keys keep their tables, and removal restores every byte`, () => {
      const out = withStarshipTheme(owner, theme);
      const parsed = parse(out);
      expect(parsed.palette).toBe(starshipPaletteName(theme));
      expect(Object.keys(parsed.palettes)).toEqual([starshipPaletteName(theme)]);
      expect(parse(withoutStarshipTheme(out))).toEqual(parse(owner));
      expect(withoutStarshipTheme(out)).toBe(owner);
      expect(starshipThemeStateOf(out, theme)).toBe("current");
    });
  }

  it("keeps the owner's line endings", () => {
    const out = withStarshipTheme(CRLF, theme);
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("puts the palette line before the owner's first table and the palette table after everything", () => {
    const out = withStarshipTheme(OWNER_WITH_TABLES, theme);
    expect(out.startsWith(`${STARSHIP_SELECT_MARKERS.begin}\npalette = `)).toBe(true);
    expect(out.trimEnd().endsWith(STARSHIP_PALETTE_MARKERS.end)).toBe(true);
    expect(parse(out).directory.style).toBe("bold path");
  });

  it("leaves a file with its own palette alone", () => {
    expect(starshipThemeStateOf(OWN_PALETTE, theme)).toBe("foreign");
    expect(parse(OWN_PALETTE).palette).toBe("mine");
  });
});

describe("starship theme state", () => {
  it("is absent on a file without the blocks", () => {
    expect(starshipThemeStateOf("", theme)).toBe("absent");
    expect(starshipThemeStateOf(OWNER_WITH_TABLES, theme)).toBe("absent");
  });

  it("is stale when one block is missing or edited", () => {
    const out = withStarshipTheme(OWNER_WITH_TABLES, theme);
    expect(starshipThemeStateOf(out.replace('purple = "#bd93f9"', 'purple = "#000000"'), theme)).toBe("stale");
    const selectOnly = out.slice(0, out.indexOf(STARSHIP_PALETTE_MARKERS.begin));
    expect(starshipThemeStateOf(selectOnly, theme)).toBe("stale");
  });

  it("is foreign for an unpaired marker, an owner palette of our name, or an owner file that is not TOML", () => {
    expect(starshipThemeStateOf(`${STARSHIP_SELECT_MARKERS.begin}\npalette = "x"\n`, theme)).toBe("foreign");
    expect(starshipThemeStateOf(`[palettes.${starshipPaletteName(theme)}]\nred = "#ff0000"\n`, theme)).toBe("foreign");
    expect(starshipThemeStateOf("palettes = { mine = { red = \"#ff0000\" } }\n", theme)).toBe("foreign");
    expect(starshipThemeStateOf('palettes.mine.red = "#ff0000"\n', theme)).toBe("foreign");
    expect(starshipThemeStateOf("[directory\n", theme)).toBe("foreign");
  });

  it("is not fooled by a palettes table of the owner's under another name", () => {
    expect(starshipThemeStateOf('[palettes.mine]\nred = "#ff0000"\n', theme)).toBe("absent");
    expect(Object.keys(parse(withStarshipTheme('[palettes.mine]\nred = "#ff0000"\n', theme)).palettes)).toEqual(["mine", starshipPaletteName(theme)]);
  });

  it("is idempotent", () => {
    const once = withStarshipTheme(OWNER_WITH_TABLES, theme);
    expect(withStarshipTheme(once, theme)).toBe(once);
  });

  it("repairs a stale file into one current pair of blocks", () => {
    const stale = withStarshipTheme(OWNER_WITH_TABLES, theme).replace('pink = "#ff79c6"', 'pink = "#000000"');
    const fixed = withStarshipTheme(stale, theme);
    expect(fixed).toBe(withStarshipTheme(OWNER_WITH_TABLES, theme));
  });
});

describe("starship theme files", () => {
  let home: string;
  let config: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pb-starship-theme-"));
    config = join(home, ".config", "starship.toml");
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const ctx = (): SetupContext => ({ claudeSettingsPath: join(home, ".claude", "settings.json") }) as unknown as SetupContext;

  it("reads ~/.config/starship.toml unless STARSHIP_CONFIG names another file", () => {
    expect(starshipConfigPath("/h", undefined)).toBe("/h/.config/starship.toml");
    expect(starshipConfigPath("/h", "")).toBe("/h/.config/starship.toml");
    expect(starshipConfigPath("/h", "/elsewhere/s.toml")).toBe("/elsewhere/s.toml");
  });

  it("is unavailable without starship on PATH", async () => {
    expect(await starshipThemeState(config, theme, missing)).toBe("unavailable");
    expect(await starshipThemeUnit(missing).inspect(ctx())).toBe("unavailable");
  });

  it("applies, reports current, and removes back to the owner's exact bytes", async () => {
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, OWNER_WITH_TABLES);
    const unit = starshipThemeUnit(installed);
    expect(unit.id).toBe("terminal:starship-theme");
    expect(unit.group).toBe("Terminal tools");
    expect(unit.defaultSelected).toBe(false);
    expect(await unit.inspect(ctx())).toBe("absent");
    await unit.apply(ctx());
    expect(await unit.inspect(ctx())).toBe("current");
    parse(await readFile(config, "utf8"));
    await unit.remove(ctx());
    expect(await readFile(config, "utf8")).toBe(OWNER_WITH_TABLES);
    expect(await unit.inspect(ctx())).toBe("absent");
  });

  it("creates the file when there is none and leaves it empty on removal", async () => {
    await applyStarshipTheme(config, theme);
    expect(await starshipThemeState(config, theme, installed)).toBe("current");
    await removeStarshipTheme(config);
    expect(await readFile(config, "utf8")).toBe("");
  });

  it("never writes into a file with its own palette", async () => {
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, OWN_PALETTE);
    await applyStarshipTheme(config, theme);
    expect(await readFile(config, "utf8")).toBe(OWN_PALETTE);
    expect(await starshipThemeState(config, theme, installed)).toBe("foreign");
  });

  it("does nothing on removal when the file does not exist", async () => {
    await removeStarshipTheme(config);
    expect(existsSync(config)).toBe(false);
  });
});
