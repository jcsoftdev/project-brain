import { existsSync } from "node:fs";
import { readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { uiRolesOf, type ThemeDefinition } from "../themes/index.js";
import { applyBlock, blockState, readTextOrEmpty, removeBlock, type BlockMarkers } from "./managed-block.js";

export const BAT_THEME_MARKER = "<!-- Managed by project-brain setup (terminal:bat-theme). Edits are overwritten; untick the unit in `project-brain setup` to remove. -->";
export const BAT_CONFIG_BEGIN = "# >>> project-brain bat theme >>>";
export const BAT_CONFIG_END = "# <<< project-brain bat theme <<<";

const CONFIG_MARKERS: BlockMarkers = { begin: BAT_CONFIG_BEGIN, end: BAT_CONFIG_END };
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const MANAGED_PREFIX = `${XML_DECLARATION}\n${BAT_THEME_MARKER}\n`;
const MANAGED_FILE_NAME = /^project-brain-.+\.tmTheme$/;
const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;

export type BatThemeState = "absent" | "current" | "stale" | "foreign";

export interface BatPaths {
  configDir: string;
  configFile: string;
  cacheDir: string;
}

export type BatEnv = Readonly<Record<string, string | undefined>>;

export type RebuildCache = () => Promise<void>;

const absoluteOr = (value: string | undefined, fallback: string): string => (value && value.startsWith("/") ? value : fallback);
const nonEmptyOr = (value: string | undefined, fallback: string): string => (value ? value : fallback);

export function batPaths(home: string, env: BatEnv): BatPaths {
  const configDir = nonEmptyOr(env.BAT_CONFIG_DIR, join(absoluteOr(env.XDG_CONFIG_HOME, join(home, ".config")), "bat"));
  return {
    configDir,
    configFile: nonEmptyOr(env.BAT_CONFIG_PATH, join(configDir, "config")),
    cacheDir: nonEmptyOr(env.BAT_CACHE_PATH, join(absoluteOr(env.XDG_CACHE_HOME, join(home, ".cache")), "bat")),
  };
}

export const batThemeName = (theme: ThemeDefinition): string => `project-brain-${theme.id}`;

export const batThemeFile = (paths: BatPaths, theme: ThemeDefinition): string =>
  join(paths.configDir, "themes", `${batThemeName(theme)}.tmTheme`);

export const batCacheBuildArgv = (bin: string, paths: BatPaths): string[] => [
  bin,
  "cache",
  "--build",
  "--source",
  paths.configDir,
  "--target",
  paths.cacheDir,
];

export const batConfigBlockOf = (theme: ThemeDefinition): string =>
  [BAT_CONFIG_BEGIN, `--theme="${batThemeName(theme)}"`, BAT_CONFIG_END].join("\n");

type FontStyle = "" | "italic" | "bold" | "underline";

interface ScopeRule {
  name: string;
  scope: string[];
  foreground: string;
  fontStyle?: FontStyle;
}

function opaque(hex: string): string {
  if (!OPAQUE_HEX.test(hex)) throw new Error(`bat drops alpha, so every theme colour must be an opaque #rrggbb; got "${hex}"`);
  return hex.toLowerCase();
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function batGlobalSettings(theme: ThemeDefinition): Record<string, string> {
  const roles = uiRolesOf(theme);
  return {
    foreground: roles.text.fg,
    background: roles.surface.base,
    caret: roles.text.fg,
    lineHighlight: roles.surface.line,
    selection: roles.surface.selection,
    gutterForeground: roles.text.gutter,
  };
}

export function batScopeRules(theme: ThemeDefinition): ScopeRule[] {
  const { syntax, text, diff, git, status } = uiRolesOf(theme);
  return [
    { name: "Comment", scope: ["comment", "punctuation.definition.comment"], foreground: syntax.comment, fontStyle: "italic" },
    { name: "Variable", scope: ["variable", "meta.object-literal.key", "punctuation"], foreground: syntax.variable },
    { name: "Keyword", scope: ["keyword", "storage", "storage.type", "storage.modifier"], foreground: syntax.keyword },
    { name: "Operator", scope: ["keyword.operator"], foreground: syntax.operator },
    { name: "Function", scope: ["entity.name.function", "meta.function-call", "variable.function"], foreground: syntax.function },
    { name: "Builtin function", scope: ["support.function"], foreground: syntax.builtin, fontStyle: "italic" },
    {
      name: "Type",
      scope: ["entity.name.type", "entity.name.class", "entity.other.inherited-class"],
      foreground: syntax.type,
    },
    {
      name: "Builtin type",
      scope: ["support.type", "support.class", "storage.type.primitive"],
      foreground: syntax.type,
      fontStyle: "italic",
    },
    { name: "String", scope: ["string"], foreground: syntax.string },
    { name: "Escape", scope: ["constant.character.escape"], foreground: syntax.escape },
    { name: "Regexp", scope: ["string.regexp"], foreground: syntax.regexp },
    { name: "Number", scope: ["constant.numeric"], foreground: syntax.number },
    {
      name: "Constant",
      scope: ["constant.language", "constant.character", "constant.other", "support.constant", "variable.other.constant"],
      foreground: syntax.constant,
    },
    { name: "Parameter", scope: ["variable.parameter"], foreground: syntax.parameter, fontStyle: "italic" },
    { name: "Language variable", scope: ["variable.language"], foreground: syntax.builtin, fontStyle: "italic" },
    { name: "Tag", scope: ["entity.name.tag"], foreground: syntax.tag },
    { name: "Tag delimiter", scope: ["punctuation.definition.tag"], foreground: syntax.tagDelimiter },
    { name: "Attribute", scope: ["entity.other.attribute-name"], foreground: syntax.attribute },
    { name: "Heading", scope: ["markup.heading", "entity.name.section"], foreground: syntax.heading, fontStyle: "bold" },
    { name: "Link", scope: ["markup.underline.link", "markup.link"], foreground: syntax.link, fontStyle: "underline" },
    { name: "Raw", scope: ["markup.raw"], foreground: syntax.raw },
    { name: "Bold", scope: ["markup.bold"], foreground: text.fg, fontStyle: "bold" },
    { name: "Italic", scope: ["markup.italic"], foreground: text.fg, fontStyle: "italic" },
    { name: "Inserted", scope: ["markup.inserted"], foreground: git.add },
    { name: "Deleted", scope: ["markup.deleted"], foreground: git.delete },
    { name: "Changed", scope: ["markup.changed"], foreground: git.change },
    { name: "Diff file", scope: ["meta.diff.header"], foreground: diff.file, fontStyle: "bold" },
    { name: "Diff hunk", scope: ["meta.diff.range"], foreground: diff.hunk },
    { name: "Invalid", scope: ["invalid"], foreground: status.error },
  ];
}

const settingsDict = (entries: Record<string, string>, indent: string): string[] => [
  `${indent}<dict>`,
  ...Object.entries(entries).flatMap(([key, value]) => [`${indent}  <key>${key}</key>`, `${indent}  <string>${escapeXml(value)}</string>`]),
  `${indent}</dict>`,
];

function ruleSettings(rule: ScopeRule): Record<string, string> {
  const foreground = { foreground: opaque(rule.foreground) };
  return rule.fontStyle === undefined ? foreground : { ...foreground, fontStyle: rule.fontStyle };
}

export function batThemeXml(theme: ThemeDefinition): string {
  const global = Object.fromEntries(Object.entries(batGlobalSettings(theme)).map(([key, hex]) => [key, opaque(hex)]));
  const rules = batScopeRules(theme).flatMap((rule) => [
    "    <dict>",
    "      <key>name</key>",
    `      <string>${escapeXml(rule.name)}</string>`,
    "      <key>scope</key>",
    `      <string>${escapeXml(rule.scope.join(", "))}</string>`,
    "      <key>settings</key>",
    ...settingsDict(ruleSettings(rule), "      "),
    "    </dict>",
  ]);
  return [
    XML_DECLARATION,
    BAT_THEME_MARKER,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>name</key>",
    `  <string>${escapeXml(`project-brain ${theme.label}`)}</string>`,
    "  <key>settings</key>",
    "  <array>",
    "    <dict>",
    "      <key>settings</key>",
    ...settingsDict(global, "      "),
    "    </dict>",
    ...rules,
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const isManaged = (text: string): boolean => text.startsWith(MANAGED_PREFIX);

function themeFileState(text: string | null, want: string): BatThemeState {
  if (text === null) return "absent";
  if (!isManaged(text)) return "foreign";
  return text === want ? "current" : "stale";
}

function combined(parts: BatThemeState[]): BatThemeState {
  if (parts.includes("foreign")) return "foreign";
  if (parts.every((part) => part === "absent")) return "absent";
  return parts.every((part) => part === "current") ? "current" : "stale";
}

export async function batThemeState(paths: BatPaths, theme: ThemeDefinition): Promise<BatThemeState> {
  const file = themeFileState(await readOrNull(batThemeFile(paths, theme)), batThemeXml(theme));
  const config = blockState(await readTextOrEmpty(paths.configFile), CONFIG_MARKERS, batConfigBlockOf(theme));
  return combined([file, config]);
}

const writeThrough = async (path: string, text: string): Promise<void> => {
  await writeFileAtomic(await realpath(path).catch(() => path), text);
};

export async function applyBatTheme(paths: BatPaths, theme: ThemeDefinition, rebuildCache: RebuildCache): Promise<void> {
  if ((await batThemeState(paths, theme)) === "foreign") return;
  await writeThrough(batThemeFile(paths, theme), batThemeXml(theme));
  await rebuildCache();
  await applyBlock(paths.configFile, CONFIG_MARKERS, batConfigBlockOf(theme));
}

async function removeManagedThemeFiles(themesDir: string): Promise<boolean> {
  if (!existsSync(themesDir)) return false;
  const candidates = (await readdir(themesDir)).filter((name) => MANAGED_FILE_NAME.test(name));
  let removed = false;
  for (const name of candidates) {
    const path = join(themesDir, name);
    const text = await readOrNull(path);
    if (text !== null && isManaged(text)) {
      await rm(path, { force: true });
      removed = true;
    }
  }
  if ((await readdir(themesDir)).length === 0) await rmdir(themesDir);
  return removed;
}

async function removeConfigBlock(configFile: string): Promise<void> {
  if (blockState(await readTextOrEmpty(configFile), CONFIG_MARKERS, "") === "foreign") return;
  await removeBlock(configFile, CONFIG_MARKERS);
  if (existsSync(configFile) && (await readTextOrEmpty(configFile)) === "") await rm(configFile, { force: true });
}

export async function removeBatTheme(paths: BatPaths, rebuildCache: RebuildCache): Promise<void> {
  await removeConfigBlock(paths.configFile);
  if (await removeManagedThemeFiles(join(paths.configDir, "themes"))) await rebuildCache();
}
