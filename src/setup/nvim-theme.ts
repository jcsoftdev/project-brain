import { existsSync } from "node:fs";
import { readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { neovimPaletteLua } from "../themes/neovim.js";
import type { ThemeDefinition } from "../themes/types.js";
// @ts-expect-error Bun's text attribute embeds the .lua as a string.
import highlightsLua from "../../templates/nvim/lua/project-brain/highlights.lua" with { type: "text" };
// @ts-expect-error Bun's text attribute embeds the .lua as a string.
import themeSpecLua from "../../templates/nvim/lua/plugins/project-brain-theme.lua" with { type: "text" };

/**
 * The Neovim colour theme, as three files setup owns outright under the Neovim config: the palette (generated from the
 * theme definition), the highlights (the same for every theme) and the lazy.nvim spec that points tokyonight at them.
 * They start with a marker line; a file at one of these paths that does not start with it is the user's and is never touched.
 */
export const NVIM_THEME_MARKER = "-- Managed by project-brain setup (nvim:theme). Edits are overwritten; untick the unit in `project-brain setup` to remove.";

export type NvimThemeState = "absent" | "current" | "stale" | "foreign";

/** Where Neovim reads its config: $XDG_CONFIG_HOME/nvim, else ~/.config/nvim. */
export function nvimConfigDir(home: string, xdg: string | undefined): string {
  return join(xdg && xdg.startsWith("/") ? xdg : join(home, ".config"), "nvim");
}

/** Every managed file for a theme, relative to the Neovim config directory. */
export function nvimThemeFiles(theme: ThemeDefinition): Record<string, string> {
  const owned = (body: string) => `${NVIM_THEME_MARKER}\n${body}`;
  return {
    "lua/project-brain/palette.lua": owned(neovimPaletteLua(theme)),
    "lua/project-brain/highlights.lua": owned(highlightsLua as string),
    "lua/plugins/project-brain-theme.lua": owned(themeSpecLua as string),
  };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function nvimThemeState(configDir: string, theme: ThemeDefinition): Promise<NvimThemeState> {
  const files = Object.entries(nvimThemeFiles(theme));
  const found = await Promise.all(files.map(async ([rel]) => readOrNull(join(configDir, rel))));
  if (found.some((text) => text !== null && !text.startsWith(NVIM_THEME_MARKER))) return "foreign";
  if (found.every((text) => text === null)) return "absent";
  return files.every(([, want], index) => found[index] === want) ? "current" : "stale";
}

export async function applyNvimTheme(configDir: string, theme: ThemeDefinition): Promise<void> {
  if ((await nvimThemeState(configDir, theme)) === "foreign") return;
  for (const [rel, text] of Object.entries(nvimThemeFiles(theme))) {
    const path = join(configDir, rel);
    await writeFileAtomic(await realpath(path).catch(() => path), text);
  }
}

export async function removeNvimTheme(configDir: string, theme: ThemeDefinition): Promise<void> {
  for (const rel of Object.keys(nvimThemeFiles(theme))) {
    const path = join(configDir, rel);
    const text = await readOrNull(path);
    if (text !== null && text.startsWith(NVIM_THEME_MARKER)) await rm(path, { force: true });
  }
  const dir = join(configDir, "lua", "project-brain");
  if (existsSync(dir) && (await readdir(dir)).length === 0) await rmdir(dir);
}
