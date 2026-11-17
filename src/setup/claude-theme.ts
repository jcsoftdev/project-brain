import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const writeSettings = (path: string, settings: Settings) => writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);

export async function claudeThemeState(claudeSettingsPath: string, theme: ThemeDefinition): Promise<ClaudeThemeState> {
  const settings = await readSettings(claudeSettingsPath);
  if (settings === "unparseable") return "foreign";
  const file = claudeThemeFileOf(claudeSettingsPath, theme);
  const isSelected = settings?.theme === claudeCodeThemeRef(theme);
  if (!existsSync(file)) return isSelected ? "stale" : "absent";
  const isCurrent = (await readFile(file, "utf8")) === claudeCodeThemeText(theme);
  return isCurrent && isSelected ? "current" : "stale";
}

export async function applyClaudeTheme(claudeSettingsPath: string, dataDir: string, theme: ThemeDefinition): Promise<void> {
  const settings = await readSettings(claudeSettingsPath);
  if (settings === "unparseable") return;
  const next: Settings = { ...(settings ?? {}) };
  const ref = claudeCodeThemeRef(theme);
  if (next.theme !== ref && !existsSync(previousPath(dataDir))) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(previousPath(dataDir), `${JSON.stringify({ theme: next.theme ?? null })}\n`, "utf8");
  }
  await mkdir(dirname(claudeThemeFileOf(claudeSettingsPath, theme)), { recursive: true });
  await writeFileAtomic(claudeThemeFileOf(claudeSettingsPath, theme), claudeCodeThemeText(theme));
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
