import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { READABLE_REPLIES_VERSION } from "../constants.js";
import pluginJson from "../../templates/claude-tui/activity-pane/.claude-plugin/plugin.json" with { type: "text" };
import hooksJson from "../../templates/claude-tui/activity-pane/hooks/hooks.json" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import registerTsx from "../../templates/claude-tui/activity-pane/hooks/register.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featAgents from "../../templates/claude-tui/activity-pane/hooks/feat-agents.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featBlocked from "../../templates/claude-tui/activity-pane/hooks/feat-blocked.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featCi from "../../templates/claude-tui/activity-pane/hooks/feat-ci.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featContext from "../../templates/claude-tui/activity-pane/hooks/feat-context.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featProgress from "../../templates/claude-tui/activity-pane/hooks/feat-progress.tsx" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import featRunning from "../../templates/claude-tui/activity-pane/hooks/feat-running.tsx" with { type: "text" };
// @ts-expect-error TypeScript refuses a value import of a .d.ts; Bun's text attribute embeds it as a string.
import typesDts from "../../templates/claude-tui/activity-pane/types/index.d.ts" with { type: "text" };
import listingPluginJson from "../../templates/claude-tui/skill-listing/.claude-plugin/plugin.json" with { type: "text" };
import listingHooksJson from "../../templates/claude-tui/skill-listing/hooks/hooks.json" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import listingRegisterTsx from "../../templates/claude-tui/skill-listing/hooks/register.tsx" with { type: "text" };
// @ts-expect-error TypeScript refuses a value import of a .d.ts; Bun's text attribute embeds it as a string.
import listingTypesDts from "../../templates/claude-tui/skill-listing/types/index.d.ts" with { type: "text" };

export const MARKETPLACE_NAME = "project-brain";

/** A Claude Code plugin setup ships from the project-brain marketplace: its files, relative to its plugin directory. */
export interface Mod {
  name: string;
  description: string;
  files: Record<string, string>;
}

export const pluginKey = (mod: Mod): string => `${mod.name}@${MARKETPLACE_NAME}`;

export const ACTIVITY_PLUGIN_NAME = "project-brain-activity";
export const ACTIVITY_PLUGIN_KEY = `${ACTIVITY_PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Every file of the activity-pane mod, relative to its plugin directory. Parity with templates/ is asserted by a test. */
export const ACTIVITY_PANE_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": pluginJson as unknown as string,
  "hooks/hooks.json": hooksJson as unknown as string,
  "hooks/register.tsx": registerTsx as string,
  "hooks/feat-agents.tsx": featAgents as string,
  "hooks/feat-blocked.tsx": featBlocked as string,
  "hooks/feat-ci.tsx": featCi as string,
  "hooks/feat-context.tsx": featContext as string,
  "hooks/feat-progress.tsx": featProgress as string,
  "hooks/feat-running.tsx": featRunning as string,
  "types/index.d.ts": typesDts as string,
};

export const ACTIVITY_MOD: Mod = {
  name: ACTIVITY_PLUGIN_NAME,
  description: "Activity side pane for Claude Code, installed by project-brain setup.",
  files: ACTIVITY_PANE_FILES,
};

export const SKILL_LISTING_PLUGIN_NAME = "project-brain-skill-listing";
export const SKILL_LISTING_PLUGIN_KEY = `${SKILL_LISTING_PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Every file of the skill-listing mod. Parity with templates/ is asserted by a test. */
export const SKILL_LISTING_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": listingPluginJson as unknown as string,
  "hooks/hooks.json": listingHooksJson as unknown as string,
  "hooks/register.tsx": listingRegisterTsx as string,
  "types/index.d.ts": listingTypesDts as string,
};

export const SKILL_LISTING_MOD: Mod = {
  name: SKILL_LISTING_PLUGIN_NAME,
  description: "Compact skill listing for Claude Code, installed by project-brain setup.",
  files: SKILL_LISTING_FILES,
};

const MODS: Mod[] = [ACTIVITY_MOD, SKILL_LISTING_MOD];

/**
 * Names only the mods that are installed: a plugin entry whose source directory is missing could
 * fail Claude Code's marketplace load for the ones that are.
 */
function marketplaceManifest(installed: Mod[]): string {
  return `${JSON.stringify(
    {
      name: MARKETPLACE_NAME,
      owner: { name: "jcsoftdev" },
      metadata: { description: "Claude Code mods installed by project-brain setup." },
      plugins: installed.map((mod) => ({ name: mod.name, source: `./${mod.name}`, description: mod.description })),
    },
    null,
    2
  )}\n`;
}

function stampOf(installed: Mod[]): string {
  const parts = installed.flatMap((mod) =>
    Object.keys(mod.files)
      .sort()
      .map((rel) => `${mod.name}/${rel} ${mod.files[rel]}`)
  );
  return Bun.hash(parts.join("") + marketplaceManifest(installed)).toString(16);
}

export const STAMP_FILE = ".project-brain-stamp";

export const TUI_KEY = "tui";
export const TUI_FULLSCREEN = "fullscreen";

/** The `tui` value from before the pane was installed, so removal can put it back. */
const PREVIOUS_TUI_FILE = "previous-tui.json";

export function marketplaceDir(dataDir: string): string {
  return join(dataDir, "claude-plugins");
}

/** The marketplace's own files, shared by every installed mod. */
function sharedFiles(dataDir: string, installed: Mod[]): Record<string, string> {
  const root = marketplaceDir(dataDir);
  return {
    [join(root, ".claude-plugin", "marketplace.json")]: marketplaceManifest(installed),
    [join(root, STAMP_FILE)]: `${stampOf(installed)}\n`,
  };
}

/** Every file setup writes for one mod, absolute, so removal deletes exactly these and nothing else. */
function modFiles(dataDir: string, mod: Mod): Record<string, string> {
  const root = marketplaceDir(dataDir);
  return Object.fromEntries(Object.entries(mod.files).map(([rel, text]) => [join(root, mod.name, rel), text]));
}

type Settings = Record<string, unknown>;
type Entries = Record<string, unknown>;

const entriesOf = (settings: Settings | null, key: string): Entries =>
  settings?.[key] && typeof settings[key] === "object" ? (settings[key] as Entries) : {};

/** Our mods with an `enabledPlugins` entry, on or off: the ones the marketplace must keep serving. */
const installedMods = (settings: Settings | null): Mod[] =>
  MODS.filter((mod) => entriesOf(settings, "enabledPlugins")[pluginKey(mod)] !== undefined);

function marketplaceSource(dataDir: string) {
  return { source: { source: "directory", path: marketplaceDir(dataDir) } };
}

function marketplaceOwnership(settings: Settings | null, dataDir: string): "none" | "ours" | "foreign" {
  const entry = entriesOf(settings, "extraKnownMarketplaces")[MARKETPLACE_NAME];
  if (entry === undefined) return "none";
  return JSON.stringify(entry) === JSON.stringify(marketplaceSource(dataDir)) ? "ours" : "foreign";
}

const previousTuiPath = (dataDir: string) => join(marketplaceDir(dataDir), PREVIOUS_TUI_FILE);

export type ModState = "absent" | "current" | "stale" | "foreign";
export type ActivityPaneState = ModState;

/** `foreign` when another marketplace already answers to the name; `stale` when the embedded mod changed or files are missing. */
export async function modState(settings: Settings | null, dataDir: string, mod: Mod): Promise<ModState> {
  const ownership = marketplaceOwnership(settings, dataDir);
  if (ownership === "foreign") return "foreign";
  const enabled = entriesOf(settings, "enabledPlugins")[pluginKey(mod)];
  if (ownership === "none" && enabled === undefined) return "absent";
  if (ownership === "none" || enabled === undefined) return "stale";
  const expected = { ...sharedFiles(dataDir, installedMods(settings)), ...modFiles(dataDir, mod) };
  for (const [path, text] of Object.entries(expected)) {
    const onDisk = await readFile(path, "utf8").catch(() => null);
    if (onDisk !== text) return "stale";
  }
  return "current";
}

/** Writes the mod and the marketplace, and registers both. A plugin the user switched off (`false`) stays off. */
export async function installMod(settings: Settings | null, dataDir: string, mod: Mod): Promise<Settings> {
  const enabled = entriesOf(settings, "enabledPlugins");
  const next: Settings = {
    ...(settings ?? {}),
    extraKnownMarketplaces: { ...entriesOf(settings, "extraKnownMarketplaces"), [MARKETPLACE_NAME]: marketplaceSource(dataDir) },
    enabledPlugins: { ...enabled, [pluginKey(mod)]: enabled[pluginKey(mod)] ?? true },
  };
  for (const [path, text] of Object.entries({ ...sharedFiles(dataDir, installedMods(next)), ...modFiles(dataDir, mod) })) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  }
  return next;
}

/**
 * Drops the mod's plugin entry and files. The marketplace entry and its own files go with the last
 * of our mods; while another stays, the manifest is rewritten without this one.
 * A foreign marketplace and its plugin entries are left alone.
 */
export async function uninstallMod(settings: Settings, dataDir: string, mod: Mod): Promise<Settings> {
  if (marketplaceOwnership(settings, dataDir) === "foreign") return settings;
  const next: Settings = { ...settings };
  const dropEntry = (key: string, entry: string) => {
    if (!(key in next)) return;
    const { [entry]: _, ...rest } = entriesOf(next, key);
    if (Object.keys(rest).length === 0) delete next[key];
    else next[key] = rest;
  };
  dropEntry("enabledPlugins", pluginKey(mod));
  const remaining = installedMods(next);
  const files = Object.keys(modFiles(dataDir, mod));
  if (remaining.length === 0) {
    dropEntry("extraKnownMarketplaces", MARKETPLACE_NAME);
    files.push(...Object.keys(sharedFiles(dataDir, [])));
  } else {
    for (const [path, text] of Object.entries(sharedFiles(dataDir, remaining))) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    }
  }
  for (const path of files) await rm(path, { force: true });
  await pruneEmptyDirs(files.map(dirname), marketplaceDir(dataDir));
  return next;
}

/** The `tui` value is not checked: fullscreen is only the default at first install, and a later choice of the user's stands. */
export async function activityPaneState(settings: Settings | null, dataDir: string): Promise<ActivityPaneState> {
  return modState(settings, dataDir, ACTIVITY_MOD);
}

/**
 * Installs the pane and, at first install only, switches Claude Code to the fullscreen renderer, the only one the pane docks right in.
 * The `tui` value it replaces is recorded then, so an update never overrides a renderer the user picked afterwards.
 */
export async function installActivityPane(settings: Settings | null, dataDir: string): Promise<Settings> {
  const next = await installMod(settings, dataDir, ACTIVITY_MOD);
  if (existsSync(previousTuiPath(dataDir))) return next;
  const previous = settings?.[TUI_KEY] === undefined ? {} : { [TUI_KEY]: settings[TUI_KEY] };
  await writeFile(previousTuiPath(dataDir), `${JSON.stringify(previous)}\n`, "utf8");
  return { ...next, [TUI_KEY]: TUI_FULLSCREEN };
}

/**
 * Removes the pane and puts the previous `tui` value back unless the user changed it since.
 * Without the record of what install replaced, `tui` is left as it is: it may be the user's own.
 */
export async function uninstallActivityPane(settings: Settings, dataDir: string): Promise<Settings> {
  if (marketplaceOwnership(settings, dataDir) === "foreign") return settings;
  const next = await uninstallMod(settings, dataDir, ACTIVITY_MOD);
  if (settings[TUI_KEY] === TUI_FULLSCREEN && existsSync(previousTuiPath(dataDir))) {
    const previous = await readPreviousTui(dataDir);
    if (previous === undefined || previous === null) delete next[TUI_KEY];
    else next[TUI_KEY] = previous;
  }
  await rm(previousTuiPath(dataDir), { force: true });
  await pruneEmptyDirs([marketplaceDir(dataDir)], marketplaceDir(dataDir));
  return next;
}

/** `undefined` when the key was absent before install, or when nothing was recorded. */
async function readPreviousTui(dataDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(previousTuiPath(dataDir), "utf8"))[TUI_KEY];
  } catch {
    return undefined;
  }
}

/** Removes the now-empty directories setup created, deepest first, never one with anything left in it. */
async function pruneEmptyDirs(dirs: string[], root: string): Promise<void> {
  const candidates = new Set<string>();
  for (let dir of dirs) {
    while (dir.startsWith(root)) {
      candidates.add(dir);
      dir = dirname(dir);
    }
  }
  for (const dir of [...candidates].sort((a, b) => b.length - a.length)) {
    if (!existsSync(dir)) continue;
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  }
}

export const READABLE_REPLIES_SECTION_ID = "project-brain-readable-replies";

export const READABLE_REPLIES_CONTENT = `<!-- readable-replies-version: ${READABLE_REPLIES_VERSION} -->
## Readable replies

- Open with the result in one or two plain sentences.
- Full sentences, short paragraphs. No telegraphic fragments, no dropped articles.
- Tables only to compare things. Lists only for genuinely separate items.
- Technical evidence (commit hashes, test counts, paths) goes at the end, or only when asked.
- Do not narrate commands while working: no "now I run X" notes between tool calls. Speak when there is a result, a question, or a warning.`;
