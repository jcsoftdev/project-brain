import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { uiRolesOf } from "../themes/roles.js";
import type { ThemeDefinition } from "../themes/types.js";
import { blockState, readTextOrEmpty, withBlock, withoutBlock, type BlockMarkers, type BlockState } from "./managed-block.js";

export type Which = (name: string) => string | null;
export type StarshipThemeState = BlockState | "unavailable";

export const STARSHIP_SELECT_MARKERS: BlockMarkers = {
  begin: "# >>> project-brain starship palette >>>",
  end: "# <<< project-brain starship palette <<<",
};

export const STARSHIP_PALETTE_MARKERS: BlockMarkers = {
  begin: "# >>> project-brain starship colours >>>",
  end: "# <<< project-brain starship colours <<<",
};

export function starshipConfigPath(home: string, starshipConfig: string | undefined): string {
  return starshipConfig && starshipConfig.length > 0 ? starshipConfig : join(home, ".config", "starship.toml");
}

export const starshipPaletteName = (theme: ThemeDefinition): string => `project-brain-${theme.id}`;

export function starshipPaletteColours(theme: ThemeDefinition): Record<string, string> {
  const roles = uiRolesOf(theme);
  return {
    background: roles.surface.base,
    foreground: roles.text.fg,
    selection: roles.surface.selection,
    comment: roles.text.comment,
    red: roles.accent.red,
    orange: roles.accent.orange,
    yellow: roles.accent.yellow,
    green: roles.accent.green,
    cyan: roles.accent.cyan,
    purple: roles.accent.purple,
    pink: roles.accent.pink,
    muted: roles.text.muted,
    hint: roles.text.hint,
    path: roles.text.path,
    line: roles.surface.line,
    error: roles.status.error,
    warning: roles.status.warning,
    info: roles.status.info,
    progress: roles.status.progress,
    success: roles.git.add,
    git_added: roles.git.add,
    git_changed: roles.git.change,
    git_deleted: roles.git.delete,
    git_dirty: roles.git.unstaged,
    branch: roles.picker.pointer,
    vim_normal: roles.border.focus,
  };
}

export function starshipSelectBlock(theme: ThemeDefinition): string {
  return [STARSHIP_SELECT_MARKERS.begin, `palette = "${starshipPaletteName(theme)}"`, STARSHIP_SELECT_MARKERS.end].join("\n");
}

export function starshipPaletteBlock(theme: ThemeDefinition): string {
  const colours = Object.entries(starshipPaletteColours(theme)).map(([name, hex]) => `${name} = "${hex}"`);
  return [STARSHIP_PALETTE_MARKERS.begin, `[palettes.${starshipPaletteName(theme)}]`, ...colours, STARSHIP_PALETTE_MARKERS.end].join("\n");
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

function withLeadingBlock(text: string, markers: BlockMarkers, block: string): string {
  const rest = withoutBlock(text, markers);
  const eol = eolOf(text);
  const head = block.split("\n").join(eol) + eol;
  return rest === "" ? head : head + eol + rest;
}

export function withoutStarshipTheme(text: string): string {
  return withoutBlock(withoutBlock(text, STARSHIP_SELECT_MARKERS), STARSHIP_PALETTE_MARKERS);
}

export function withStarshipTheme(text: string, theme: ThemeDefinition): string {
  const selected = withLeadingBlock(withoutStarshipTheme(text), STARSHIP_SELECT_MARKERS, starshipSelectBlock(theme));
  return withBlock(selected, STARSHIP_PALETTE_MARKERS, starshipPaletteBlock(theme));
}

function parsesAsToml(text: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const PALETTES_AS_KEY = /^\s*["']?palettes["']?\s*[.=]/m;

function ownsPaletteChoice(ownerText: string, theme: ThemeDefinition): boolean {
  const owner = parsesAsToml(ownerText);
  if (owner === null || PALETTES_AS_KEY.test(ownerText)) return true;
  const palettes = owner.palettes as Record<string, unknown> | undefined;
  return "palette" in owner || (palettes !== undefined && starshipPaletteName(theme) in palettes);
}

export function starshipThemeStateOf(text: string, theme: ThemeDefinition): BlockState {
  const select = blockState(text, STARSHIP_SELECT_MARKERS, starshipSelectBlock(theme));
  const palette = blockState(text, STARSHIP_PALETTE_MARKERS, starshipPaletteBlock(theme));
  if (select === "foreign" || palette === "foreign") return "foreign";
  if (ownsPaletteChoice(withoutStarshipTheme(text), theme)) return "foreign";
  if (parsesAsToml(withStarshipTheme(text, theme)) === null) return "foreign";
  if (select === "absent" && palette === "absent") return "absent";
  return select === "current" && palette === "current" ? "current" : "stale";
}

export async function starshipThemeState(path: string, theme: ThemeDefinition, which: Which): Promise<StarshipThemeState> {
  if (!which("starship")) return "unavailable";
  return starshipThemeStateOf(await readTextOrEmpty(path), theme);
}

const targetOf = (path: string): Promise<string> => realpath(path).catch(() => path);

async function writeIfChanged(path: string, before: string, after: string): Promise<void> {
  if (after === before) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(await targetOf(path), after);
}

export async function applyStarshipTheme(path: string, theme: ThemeDefinition): Promise<void> {
  const before = await readTextOrEmpty(path);
  if (starshipThemeStateOf(before, theme) === "foreign") return;
  await writeIfChanged(path, before, withStarshipTheme(before, theme));
}

export async function removeStarshipTheme(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const before = await readTextOrEmpty(path);
  await writeIfChanged(path, before, withoutStarshipTheme(before));
}
