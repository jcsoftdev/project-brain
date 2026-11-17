import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BAT_CONFIG_BEGIN,
  BAT_CONFIG_END,
  BAT_CACHE_MARKER,
  BAT_THEME_MARKER,
  applyBatTheme,
  batCacheBuildArgv,
  batCacheClearArgv,
  batPaths,
  batScopeRules,
  batThemeFile,
  batThemeName,
  batThemeState,
  batThemeXml,
  removeBatTheme,
  type BatPaths,
} from "../../src/setup/bat-theme.js";
import { batThemeUnit } from "../../src/setup/units-bat.js";
import type { SetupContext } from "../../src/setup/units.js";
import { themeById, uiRolesOf, type ThemeDefinition } from "../../src/themes/index.js";

const theme = themeById("dracula");
const roles = uiRolesOf(theme);
let home: string;
let paths: BatPaths;
let rebuilds: number;
let clears: number;
const rebuild = async () => {
  rebuilds += 1;
};
const clear = async () => {
  clears += 1;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pb-bat-theme-"));
  paths = batPaths(home, {});
  rebuilds = 0;
  clears = 0;
});
afterEach(() => rm(home, { recursive: true, force: true }));

const ruleFor = (scope: string) => batScopeRules(theme).find((rule) => rule.scope.includes(scope));
const ctxFor = (dir: string, runService?: (argv: string[]) => Promise<number>) =>
  ({ claudeSettingsPath: join(dir, ".claude", "settings.json"), runService }) as unknown as SetupContext;

describe("bat config location", () => {
  it("follows bat: BAT_CONFIG_DIR, else an absolute XDG_CONFIG_HOME, else ~/.config/bat", () => {
    expect(batPaths("/h", {})).toEqual({ configDir: "/h/.config/bat", configFile: "/h/.config/bat/config", cacheDir: "/h/.cache/bat" });
    expect(batPaths("/h", { XDG_CONFIG_HOME: "/x", XDG_CACHE_HOME: "/c" })).toEqual({
      configDir: "/x/bat",
      configFile: "/x/bat/config",
      cacheDir: "/c/bat",
    });
    expect(batPaths("/h", { XDG_CONFIG_HOME: "relative" }).configDir).toBe("/h/.config/bat");
    expect(batPaths("/h", { BAT_CONFIG_DIR: "/d", BAT_CONFIG_PATH: "/p", BAT_CACHE_PATH: "/k" })).toEqual({
      configDir: "/d",
      configFile: "/p",
      cacheDir: "/k",
    });
  });

  it("rebuilds the cache from that config directory into that cache directory", () => {
    expect(batCacheBuildArgv("bat", paths)).toEqual(["bat", "cache", "--build", "--source", paths.configDir, "--target", paths.cacheDir]);
  });
});

describe("bat theme generator", () => {
  it("paints code with the theme's syntax roles", () => {
    expect(ruleFor("keyword")?.foreground).toBe(roles.syntax.keyword);
    expect(ruleFor("storage.type")?.foreground).toBe(roles.syntax.keyword);
    expect(ruleFor("entity.name.function")?.foreground).toBe(roles.syntax.function);
    expect(ruleFor("entity.name.type")?.foreground).toBe(roles.syntax.type);
    expect(ruleFor("support.type")).toMatchObject({ foreground: roles.syntax.type, fontStyle: "italic" });
    expect(ruleFor("string")?.foreground).toBe(roles.syntax.string);
    expect(ruleFor("constant.numeric")?.foreground).toBe(roles.syntax.number);
    expect(ruleFor("constant.language")?.foreground).toBe(roles.syntax.constant);
    expect(ruleFor("variable.parameter")).toMatchObject({ foreground: roles.syntax.parameter, fontStyle: "italic" });
    expect(ruleFor("comment")).toMatchObject({ foreground: roles.syntax.comment, fontStyle: "italic" });
    expect(ruleFor("markup.deleted")?.foreground).toBe(roles.git.delete);
    expect(ruleFor("meta.diff.range")?.foreground).toBe(roles.diff.hunk);
  });

  it("puts the owner's palette into the XML: pink keywords, yellow strings, purple numbers, the line layer for the highlighted line", () => {
    const xml = batThemeXml(theme);
    expect(xml.split("\n")[1]).toBe(BAT_THEME_MARKER);
    expect(xml).toContain("<key>lineHighlight</key>\n        <string>#2b2b38</string>");
    expect(xml).toContain("<key>gutterForeground</key>\n        <string>#6272a4</string>");
    expect(xml).toContain("<key>background</key>\n        <string>#17141d</string>");
    expect(xml).toMatch(/<string>Keyword<\/string>[\s\S]*?<string>#ff79c6<\/string>/);
    expect(xml).toMatch(/<string>String<\/string>[\s\S]*?<string>#f1fa8c<\/string>/);
    expect(xml).toMatch(/<string>Number<\/string>[\s\S]*?<string>#bd93f9<\/string>/);
  });

  it("writes only opaque #rrggbb colours, since bat drops alpha", () => {
    const colours = [...batThemeXml(theme).matchAll(/<string>(#[^<]*)<\/string>/g)].map((match) => match[1]);
    expect(colours.length).toBeGreaterThan(20);
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("refuses a colour with alpha instead of letting bat paint it solid", () => {
    const translucent: ThemeDefinition = { ...theme, accents: { ...theme.accents, pink: "#ff79c680" } };
    expect(() => batThemeXml(translucent)).toThrow(/opaque/);
  });
});

describe("bat theme files", () => {
  const configText = () => readFile(paths.configFile, "utf8");

  it("writes the theme and a --theme block, rebuilding the cache, and is idempotent", async () => {
    expect(await batThemeState(paths, theme)).toBe("absent");
    await applyBatTheme(paths, theme, rebuild);
    expect(await batThemeState(paths, theme)).toBe("current");
    expect(await readFile(batThemeFile(paths, theme), "utf8")).toBe(batThemeXml(theme));
    expect(await configText()).toBe(`${BAT_CONFIG_BEGIN}\n--theme="project-brain-dracula"\n${BAT_CONFIG_END}\n`);
    expect(rebuilds).toBe(1);
    await applyBatTheme(paths, theme, rebuild);
    expect(await configText()).toBe(`${BAT_CONFIG_BEGIN}\n--theme="project-brain-dracula"\n${BAT_CONFIG_END}\n`);
    expect(await batThemeState(paths, theme)).toBe("current");
  });

  it("puts the block after the owner's own --theme so it wins, and hands it back on removal", async () => {
    const mine = '--theme="TwoDark"\n--style=numbers\n';
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, mine);
    await applyBatTheme(paths, theme, rebuild);
    expect(await configText()).toBe(`${mine}\n${BAT_CONFIG_BEGIN}\n--theme="${batThemeName(theme)}"\n${BAT_CONFIG_END}\n`);
    await removeBatTheme(paths, rebuild, clear);
    expect(await configText()).toBe(mine);
    expect(existsSync(batThemeFile(paths, theme))).toBe(false);
    expect([rebuilds, clears]).toEqual([1, 1]);
  });

  it("calls an edited theme stale and puts it back on apply", async () => {
    await applyBatTheme(paths, theme, rebuild);
    await writeFile(batThemeFile(paths, theme), `${batThemeXml(theme)}<!-- edit -->\n`);
    expect(await batThemeState(paths, theme)).toBe("stale");
    await applyBatTheme(paths, theme, rebuild);
    expect(await batThemeState(paths, theme)).toBe("current");
  });

  it("calls a missing config block stale", async () => {
    await applyBatTheme(paths, theme, rebuild);
    await writeFile(paths.configFile, "--style=plain\n");
    expect(await batThemeState(paths, theme)).toBe("stale");
  });

  it("never touches a theme file of the owner's at its path", async () => {
    const file = batThemeFile(paths, theme);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "<plist>mine</plist>\n");
    expect(await batThemeState(paths, theme)).toBe("foreign");
    await applyBatTheme(paths, theme, rebuild);
    await removeBatTheme(paths, rebuild, clear);
    expect(await readFile(file, "utf8")).toBe("<plist>mine</plist>\n");
    expect(existsSync(paths.configFile)).toBe(false);
    expect(rebuilds).toBe(0);
  });

  it("leaves a config with an unpaired marker alone", async () => {
    const broken = `--style=plain\n${BAT_CONFIG_BEGIN}\n--theme="x"\n`;
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, broken);
    expect(await batThemeState(paths, theme)).toBe("foreign");
    await applyBatTheme(paths, theme, rebuild);
    await removeBatTheme(paths, rebuild, clear);
    expect(await configText()).toBe(broken);
    expect(existsSync(batThemeFile(paths, theme))).toBe(false);
  });

  it("removes only what it wrote: the owner's other themes and config stay, a config it created goes", async () => {
    const other = join(paths.configDir, "themes", "Mine.tmTheme");
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, "<plist/>\n");
    await applyBatTheme(paths, theme, rebuild);
    await removeBatTheme(paths, rebuild, clear);
    expect(await readFile(other, "utf8")).toBe("<plist/>\n");
    expect(existsSync(paths.configFile)).toBe(false);
    expect(await batThemeState(paths, theme)).toBe("absent");
  });

  it("removes the themes directory it made and rebuilds nothing when nothing was there", async () => {
    await removeBatTheme(paths, rebuild, clear);
    expect(rebuilds).toBe(0);
    await applyBatTheme(paths, theme, rebuild);
    await removeBatTheme(paths, rebuild, clear);
    expect(existsSync(join(paths.configDir, "themes"))).toBe(false);
  });

  it("clears on removal a cache it built first, and leaves no marker behind", async () => {
    await applyBatTheme(paths, theme, rebuild);
    expect(existsSync(join(paths.cacheDir, BAT_CACHE_MARKER))).toBe(true);
    await removeBatTheme(paths, rebuild, clear);
    expect([rebuilds, clears]).toEqual([1, 1]);
    expect(existsSync(join(paths.cacheDir, BAT_CACHE_MARKER))).toBe(false);
  });

  it("rebuilds, never clears, a cache the owner already had", async () => {
    await mkdir(paths.cacheDir, { recursive: true });
    await writeFile(join(paths.cacheDir, "metadata.yaml"), "bat_version: 0.26.1\n");
    await applyBatTheme(paths, theme, rebuild);
    expect(existsSync(join(paths.cacheDir, BAT_CACHE_MARKER))).toBe(false);
    await removeBatTheme(paths, rebuild, clear);
    expect([rebuilds, clears]).toEqual([2, 0]);
  });

  it("rebuilds a cache it built when the owner has added themes of their own since, and hands it over", async () => {
    await applyBatTheme(paths, theme, rebuild);
    await writeFile(join(paths.configDir, "themes", "Mine.tmTheme"), "<plist/>\n");
    await removeBatTheme(paths, rebuild, clear);
    expect([rebuilds, clears]).toEqual([2, 0]);
    expect(existsSync(join(paths.cacheDir, BAT_CACHE_MARKER))).toBe(false);
  });

  it("calls the theme stale while the cache is missing or was built by another bat", async () => {
    await applyBatTheme(paths, theme, rebuild);
    expect(await batThemeState(paths, theme)).toBe("current");
    expect(await batThemeState(paths, theme, "0.26.1")).toBe("stale");
    await writeFile(join(paths.cacheDir, "metadata.yaml"), "bat_version: 0.24.0\ncreation_time:\n  secs_since_epoch: 1\n");
    expect(await batThemeState(paths, theme, "0.26.1")).toBe("stale");
    await writeFile(join(paths.cacheDir, "metadata.yaml"), "bat_version: 0.26.1\n");
    expect(await batThemeState(paths, theme, "0.26.1")).toBe("current");
  });

  it("does not write the --theme block when the cache rebuild fails", async () => {
    const failing = async () => {
      throw new Error("cache");
    };
    await expect(applyBatTheme(paths, theme, failing)).rejects.toThrow("cache");
    expect(existsSync(paths.configFile)).toBe(false);
  });
});

describe("terminal:bat-theme unit", () => {
  const recorder = () => {
    const calls: string[][] = [];
    return { calls, run: async (argv: string[]) => (calls.push(argv), 0) };
  };

  it("is unavailable without bat, and finds Debian's batcat", async () => {
    expect(await batThemeUnit(() => null).inspect(ctxFor(home))).toBe("unavailable");
    const debian = batThemeUnit((command) => (command === "batcat" ? "/usr/bin/batcat" : null));
    const { calls, run } = recorder();
    expect(await debian.inspect(ctxFor(home, run))).toBe("absent");
    await debian.apply(ctxFor(home, run));
    expect(calls).toEqual([batCacheBuildArgv("/usr/bin/batcat", paths)]);
  });

  it("is opt-in, under Terminal tools, and rebuilds the cache through the injected runner", async () => {
    const unit = batThemeUnit(() => "/bin/bat");
    expect(unit).toMatchObject({ id: "terminal:bat-theme", group: "Terminal tools", defaultSelected: false });
    const { calls, run } = recorder();
    await unit.apply(ctxFor(home, run));
    expect(await unit.inspect(ctxFor(home, run))).toBe("current");
    await unit.remove(ctxFor(home, run));
    expect(await unit.inspect(ctxFor(home, run))).toBe("absent");
    expect(calls).toEqual([batCacheBuildArgv("/bin/bat", paths), batCacheClearArgv("/bin/bat", paths)]);
  });

  it("compares the cache with the installed bat's version", async () => {
    const { run } = recorder();
    const unit = batThemeUnit(() => "/bin/bat", () => "0.26.1");
    await unit.apply(ctxFor(home, run));
    expect(await unit.inspect(ctxFor(home, run))).toBe("stale");
    await writeFile(join(paths.cacheDir, "metadata.yaml"), "bat_version: 0.26.1\n");
    expect(await unit.inspect(ctxFor(home, run))).toBe("current");
  });

  it("still reports what it wrote once bat is gone, so unticking removes it and clears the cache it built", async () => {
    const { run } = recorder();
    await batThemeUnit(() => "/bin/bat").apply(ctxFor(home, run));
    await writeFile(join(paths.cacheDir, "metadata.yaml"), "bat_version: 0.26.1\n");
    const gone = batThemeUnit(() => null);
    expect(await gone.inspect(ctxFor(home, run))).toBe("current");
    await gone.apply(ctxFor(home, run));
    await gone.remove(ctxFor(home, run));
    expect(existsSync(batThemeFile(paths, theme))).toBe(false);
    expect(existsSync(join(paths.cacheDir, "metadata.yaml"))).toBe(false);
    expect(await gone.inspect(ctxFor(home, run))).toBe("unavailable");
  });

  it("reports a failed cache rebuild", async () => {
    const unit = batThemeUnit(() => "/bin/bat");
    await expect(unit.apply(ctxFor(home, async () => 1))).rejects.toThrow(/exited with 1/);
  });
});

const realBat = Bun.which("bat");

describe.skipIf(!realBat)("the real bat", () => {
  const isolatedEnv = () => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    BAT_CONFIG_DIR: paths.configDir,
    BAT_CONFIG_PATH: paths.configFile,
    BAT_CACHE_PATH: paths.cacheDir,
    BAT_PAGER: "",
  });
  const runIsolated = async (argv: string[]) => Bun.spawn(argv, { env: isolatedEnv(), stdout: "ignore", stderr: "ignore" }).exited;
  const batOutput = async (args: string[]) => {
    const child = Bun.spawn([realBat!, ...args], { env: isolatedEnv(), stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return out;
  };
  const truecolour = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    return `38;2;${r};${g};${b}m`;
  };

  it("lists the theme and paints code with it through the config block", async () => {
    await batThemeUnit(() => realBat).apply(ctxFor(home, runIsolated));
    expect(existsSync(join(paths.cacheDir, "themes.bin"))).toBe(true);
    expect(await batOutput(["--list-themes", "--color=never"])).toContain(batThemeName(theme));

    const sample = join(home, "sample.ts");
    await writeFile(sample, 'const answer = 42; // the answer\nexport function greet(name: string) { return "hi " + name; }\n');
    const painted = await batOutput(["--color=always", "--style=plain", "--paging=never", sample]);
    for (const hex of [roles.syntax.keyword, roles.syntax.string, roles.syntax.number, roles.syntax.comment, roles.syntax.function]) {
      expect(painted).toContain(truecolour(hex));
    }
  });

  it("reads current against the installed bat, and leaves bat working with no cache of its own after removal", async () => {
    const unit = batThemeUnit(() => realBat);
    await unit.apply(ctxFor(home, runIsolated));
    expect(await unit.inspect(ctxFor(home, runIsolated))).toBe("current");
    await unit.remove(ctxFor(home, runIsolated));
    expect(existsSync(join(paths.cacheDir, "themes.bin"))).toBe(false);
    const sample = join(home, "sample.sh");
    await writeFile(sample, "echo hi\n");
    const child = Bun.spawn([realBat!, "--paging=never", "--color=never", sample], { env: isolatedEnv(), stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect([code, err]).toEqual([0, ""]);
  });
});
