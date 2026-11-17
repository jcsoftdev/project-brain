import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { type UiRoles, uiRolesOf } from "../themes/roles.js";
import type { ThemeDefinition } from "../themes/types.js";
import { writeThroughLink } from "./managed-block.js";

/**
 * lazygit's theme, as a `.lazygit.yml` in the home directory. lazygit 0.66 loads a `.lazygit.yml` from every parent
 * directory of the repository it opens and merges it over the global config, so one file themes every repository
 * under home without touching the owner's `config.yml` and without an environment variable (`LG_CONFIG_FILE` makes
 * lazygit refuse to start the moment a listed file is missing). The file starts with a marker line; a `.lazygit.yml`
 * without it is the owner's and is never touched.
 */
export const LAZYGIT_THEME_MARKER =
  "# Managed by project-brain setup (terminal:lazygit-theme). Edits are overwritten; untick the unit in `project-brain setup` to remove.";

export const LAZYGIT_THEME_FILENAME = ".lazygit.yml";

export type LazygitThemeState = "absent" | "current" | "stale" | "foreign";

/** A lazygit colour attribute: at most one colour plus modifiers such as `bold`. */
export type LazygitAttribute = string[];

/** Where the theme goes and which global config files lazygit reads before it. */
export interface LazygitThemePaths {
  themeFile: string;
  ownerConfigFiles: string[];
}

const THEME_BLOCKS = ["theme", "darkTheme", "lightTheme"] as const;

/** The "Tokyo Night + Dracula" composition, one entry per `gui.theme` key lazygit 0.66.3 accepts. */
export function lazygitThemeOf(roles: UiRoles): Record<string, LazygitAttribute> {
  return {
    activeBorderColor: [roles.border.focus, "bold"],
    inactiveBorderColor: [roles.border.idle],
    searchingActiveBorderColor: [roles.border.input, "bold"],
    optionsTextColor: [roles.text.hint],
    selectedLineFgColor: ["bold"],
    selectedLineBgColor: [roles.picker.row],
    inactiveViewSelectedLineBgColor: ["bold"],
    cherryPickedCommitFgColor: [roles.text.onAccent],
    cherryPickedCommitBgColor: [roles.picker.marker],
    markedBaseCommitFgColor: [roles.text.onAccent],
    markedBaseCommitBgColor: [roles.accent.yellow],
    unstagedChangesColor: [roles.git.unstaged],
    defaultFgColor: [roles.text.fg],
  };
}

export function lazygitThemeYaml(theme: ThemeDefinition): string {
  return `${LAZYGIT_THEME_MARKER}\n${stringify({ gui: { theme: lazygitThemeOf(uiRolesOf(theme)) } })}`;
}

/** lazygit's default config directory when nothing overrides it (`lazygit --print-config-dir` knows better). */
export function lazygitConfigDir(home: string, platform: string, xdg: string | undefined): string {
  if (xdg?.startsWith("/")) return join(xdg, "lazygit");
  if (platform === "darwin") return join(home, "Library", "Application Support", "lazygit");
  return join(home, ".config", "lazygit");
}

/** The global config files lazygit reads: the `LG_CONFIG_FILE` list when set, else `config.yml` in the config dir. */
export function lazygitOwnerConfigFiles(configDir: string, lgConfigFile: string | undefined): string[] {
  const listed = (lgConfigFile ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  return listed.length > 0 ? listed : [join(configDir, "config.yml")];
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Theme keys the owner already sets that would fight the managed ones: in `gui.darkTheme`/`gui.lightTheme` they win
 * over any `gui.theme`, and in `gui.theme` the managed file would silently override the owner's choice. A config that
 * does not parse counts as a conflict, since nothing about it can be known.
 */
export async function ownerThemeConflicts(ownerConfigFiles: string[], theme: ThemeDefinition): Promise<string[]> {
  const managedKeys = Object.keys(lazygitThemeOf(uiRolesOf(theme)));
  const conflicts: string[] = [];
  for (const file of ownerConfigFiles) {
    const text = await readOrNull(file);
    if (text === null) continue;
    let config: unknown;
    try {
      config = parse(text);
    } catch {
      conflicts.push(`${file}: unparseable`);
      continue;
    }
    const gui = (config as { gui?: Record<string, unknown> } | null)?.gui;
    for (const block of THEME_BLOCKS) {
      const keys = gui?.[block];
      if (!keys || typeof keys !== "object") continue;
      for (const key of managedKeys) if (key in keys) conflicts.push(`${file}: gui.${block}.${key}`);
    }
  }
  return conflicts;
}

export async function lazygitThemeState(paths: LazygitThemePaths, theme: ThemeDefinition): Promise<LazygitThemeState> {
  const text = await readOrNull(paths.themeFile);
  if (text !== null && !text.startsWith(LAZYGIT_THEME_MARKER)) return "foreign";
  if ((await ownerThemeConflicts(paths.ownerConfigFiles, theme)).length > 0) return "foreign";
  if (text === null) return "absent";
  return text === lazygitThemeYaml(theme) ? "current" : "stale";
}

export async function applyLazygitTheme(paths: LazygitThemePaths, theme: ThemeDefinition): Promise<void> {
  if ((await lazygitThemeState(paths, theme)) === "foreign") return;
  await writeThroughLink(paths.themeFile, lazygitThemeYaml(theme));
}

export async function removeLazygitTheme(paths: LazygitThemePaths): Promise<void> {
  const text = await readOrNull(paths.themeFile);
  if (text !== null && text.startsWith(LAZYGIT_THEME_MARKER)) await rm(paths.themeFile, { force: true });
}
