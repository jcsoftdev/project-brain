import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { claudeCodeThemeRef, claudeCodeThemeSlug, claudeCodeThemeText } from "../themes/claude-code.js";
import type { ThemeDefinition } from "../themes/types.js";

/**
 * The theme as a Claude Code custom theme: one file under ~/.claude/themes that setup owns outright (its name carries
 * the `project-brain-` prefix), plus the `theme` setting pointing at it. The engine draws the chat and the /diff view
 * from this theme, so this is what makes them match the terminal and the activity pane.
 * The `theme` value from before is kept in the data dir so removal puts it back.
 */
const PREVIOUS_THEME_FILE = "previous-theme.json";

type Settings = Record<string, unknown>;
export type ClaudeThemeState = "absent" | "current" | "stale" | "foreign";

export const claudeThemeFileOf = (claudeSettingsPath: string, theme: ThemeDefinition): string =>
  join(dirname(claudeSettingsPath), "themes", `${claudeCodeThemeSlug(theme)}.json`);

const previousPath = (dataDir: string) => join(dataDir, PREVIOUS_THEME_FILE);

async function readSettings(path: string): Promise<Settings | null | "unparseable"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Settings) : "unparseable";
  } catch {
    return "unparseable";
  }
}

/** A symlinked file (dotfiles setups) is written through, not replaced by a regular file. */
const targetOf = (path: string): Promise<string> => realpath(path).catch(() => path);
const writeThrough = async (path: string, text: string) => writeFileAtomic(await targetOf(path), text);
const writeSettings = (path: string, settings: Settings) => writeThrough(path, `${JSON.stringify(settings, null, 2)}\n`);

/**
 * `current` when the file is up to date and either selected or chosen away from by the user after setup applied it
 * (the data dir still remembers the theme it replaced): a theme the person picked since is theirs, and `update` must not undo it.
 */
export async function claudeThemeState(claudeSettingsPath: string, dataDir: string, theme: ThemeDefinition): Promise<ClaudeThemeState> {
  const settings = await readSettings(claudeSettingsPath);
  if (settings === "unparseable") return "foreign";
  const file = claudeThemeFileOf(claudeSettingsPath, theme);
  const isSelected = settings?.theme === claudeCodeThemeRef(theme);
  if (!existsSync(file)) return isSelected ? "stale" : "absent";
  const isCurrent = (await readFile(file, "utf8")) === claudeCodeThemeText(theme);
  const isAppliedBefore = existsSync(previousPath(dataDir));
  return isCurrent && (isSelected || isAppliedBefore) ? "current" : "stale";
}

export async function applyClaudeTheme(claudeSettingsPath: string, dataDir: string, theme: ThemeDefinition): Promise<void> {
  const settings = await readSettings(claudeSettingsPath);
  if (settings === "unparseable") return;
  const next: Settings = { ...(settings ?? {}) };
  const ref = claudeCodeThemeRef(theme);
  const isAppliedBefore = existsSync(previousPath(dataDir));
  if (next.theme !== ref && !isAppliedBefore) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(previousPath(dataDir), `${JSON.stringify({ theme: next.theme ?? null })}\n`, "utf8");
  }
  await mkdir(dirname(claudeThemeFileOf(claudeSettingsPath, theme)), { recursive: true });
  await writeThrough(claudeThemeFileOf(claudeSettingsPath, theme), claudeCodeThemeText(theme));
  // Applied before and the person has picked another theme since: refresh the file, keep their choice.
  if (isAppliedBefore && next.theme !== ref) return;
  next.theme = ref;
  await mkdir(dirname(claudeSettingsPath), { recursive: true });
  await writeSettings(claudeSettingsPath, next);
}

export async function removeClaudeTheme(claudeSettingsPath: string, dataDir: string, theme: ThemeDefinition): Promise<void> {
  const settings = await readSettings(claudeSettingsPath);
  if (settings === "unparseable") return;
  if (settings?.theme === claudeCodeThemeRef(theme)) {
    const next: Settings = { ...settings };
    const previous = await readFile(previousPath(dataDir), "utf8")
      .then((text) => (JSON.parse(text) as { theme?: unknown }).theme)
      .catch(() => null);
    if (typeof previous === "string") next.theme = previous;
    else delete next.theme;
    await writeSettings(claudeSettingsPath, next);
  }
  await rm(claudeThemeFileOf(claudeSettingsPath, theme), { force: true });
  await rm(previousPath(dataDir), { force: true });
}
