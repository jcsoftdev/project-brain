import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { READABLE_REPLIES_VERSION } from "../constants.js";
import pluginJson from "../../templates/claude-tui/activity-pane/.claude-plugin/plugin.json" with { type: "text" };
import hooksJson from "../../templates/claude-tui/activity-pane/hooks/hooks.json" with { type: "text" };
// @ts-expect-error TypeScript resolves the .tsx as source (and wants --jsx); Bun's text attribute embeds it as a string.
import registerTsx from "../../templates/claude-tui/activity-pane/hooks/register.tsx" with { type: "text" };
// @ts-expect-error TypeScript refuses a value import of a .d.ts; Bun's text attribute embeds it as a string.
import typesDts from "../../templates/claude-tui/activity-pane/types/index.d.ts" with { type: "text" };

export const MARKETPLACE_NAME = "project-brain";
export const ACTIVITY_PLUGIN_NAME = "project-brain-activity";
export const ACTIVITY_PLUGIN_KEY = `${ACTIVITY_PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Every file of the activity-pane mod, relative to its plugin directory. Parity with templates/ is asserted by a test. */
export const ACTIVITY_PANE_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": pluginJson as unknown as string,
  "hooks/hooks.json": hooksJson as unknown as string,
  "hooks/register.tsx": registerTsx as string,
  "types/index.d.ts": typesDts as string,
};

const MARKETPLACE_MANIFEST = `${JSON.stringify(
  {
    name: MARKETPLACE_NAME,
    owner: { name: "jcsoftdev" },
    metadata: { description: "Claude Code mods installed by project-brain setup." },
    plugins: [
      {
        name: ACTIVITY_PLUGIN_NAME,
        source: `./${ACTIVITY_PLUGIN_NAME}`,
        description: "Activity side pane for Claude Code, installed by project-brain setup.",
      },
    ],
  },
  null,
  2
)}\n`;

export const ACTIVITY_PANE_STAMP: string = Bun.hash(
  Object.keys(ACTIVITY_PANE_FILES)
    .sort()
    .map((rel) => `${rel} ${ACTIVITY_PANE_FILES[rel]}`)
    .join("") + MARKETPLACE_MANIFEST
).toString(16);

export const STAMP_FILE = ".project-brain-stamp";

export const TUI_KEY = "tui";
export const TUI_FULLSCREEN = "fullscreen";

/** The `tui` value from before the pane was installed, so removal can put it back. */
const PREVIOUS_TUI_FILE = "previous-tui.json";

export function marketplaceDir(dataDir: string): string {
  return join(dataDir, "claude-plugins");
}

/** Every file setup writes for the pane, absolute, so removal deletes exactly these and nothing else. */
function ownedFiles(dataDir: string): Record<string, string> {
  const root = marketplaceDir(dataDir);
  const files: Record<string, string> = {
    [join(root, ".claude-plugin", "marketplace.json")]: MARKETPLACE_MANIFEST,
    [join(root, STAMP_FILE)]: `${ACTIVITY_PANE_STAMP}\n`,
  };
  for (const [rel, text] of Object.entries(ACTIVITY_PANE_FILES)) {
    files[join(root, ACTIVITY_PLUGIN_NAME, rel)] = text;
  }
  return files;
}

type Settings = Record<string, unknown>;
type Entries = Record<string, unknown>;

const entriesOf = (settings: Settings | null, key: string): Entries =>
  settings?.[key] && typeof settings[key] === "object" ? (settings[key] as Entries) : {};

function marketplaceSource(dataDir: string) {
  return { source: { source: "directory", path: marketplaceDir(dataDir) } };
}

function marketplaceOwnership(settings: Settings | null, dataDir: string): "none" | "ours" | "foreign" {
  const entry = entriesOf(settings, "extraKnownMarketplaces")[MARKETPLACE_NAME];
  if (entry === undefined) return "none";
  return JSON.stringify(entry) === JSON.stringify(marketplaceSource(dataDir)) ? "ours" : "foreign";
}

const previousTuiPath = (dataDir: string) => join(marketplaceDir(dataDir), PREVIOUS_TUI_FILE);

export type ActivityPaneState = "absent" | "current" | "stale" | "foreign";

/**
 * `foreign` when another marketplace already answers to the name; `stale` when the embedded mod changed or files are missing.
 * The `tui` value is not checked: fullscreen is only the default at first install, and a later choice of the user's stands.
 */
export async function activityPaneState(settings: Settings | null, dataDir: string): Promise<ActivityPaneState> {
  const ownership = marketplaceOwnership(settings, dataDir);
  if (ownership === "foreign") return "foreign";
  const enabled = entriesOf(settings, "enabledPlugins")[ACTIVITY_PLUGIN_KEY];
  if (ownership === "none" && enabled === undefined) return "absent";
  if (ownership === "none" || enabled === undefined) return "stale";
  for (const [path, text] of Object.entries(ownedFiles(dataDir))) {
    const onDisk = await readFile(path, "utf8").catch(() => null);
    if (onDisk !== text) return "stale";
  }
  return "current";
}

/**
 * Writes the marketplace directory and, at first install only, switches Claude Code to the fullscreen renderer, the only one the pane docks right in.
 * The `tui` value it replaces is recorded then, so an update never overrides a renderer the user picked afterwards.
 * A plugin the user switched off (`false`) stays off.
 */
export async function installActivityPane(settings: Settings | null, dataDir: string): Promise<Settings> {
  for (const [path, text] of Object.entries(ownedFiles(dataDir))) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  }
  const isFirstInstall = !existsSync(previousTuiPath(dataDir));
  if (isFirstInstall) {
    const previous = settings?.[TUI_KEY] === undefined ? {} : { [TUI_KEY]: settings[TUI_KEY] };
    await writeFile(previousTuiPath(dataDir), `${JSON.stringify(previous)}\n`, "utf8");
  }
  const enabled = entriesOf(settings, "enabledPlugins");
  return {
    ...(settings ?? {}),
    ...(isFirstInstall ? { [TUI_KEY]: TUI_FULLSCREEN } : {}),
    extraKnownMarketplaces: { ...entriesOf(settings, "extraKnownMarketplaces"), [MARKETPLACE_NAME]: marketplaceSource(dataDir) },
    enabledPlugins: { ...enabled, [ACTIVITY_PLUGIN_KEY]: enabled[ACTIVITY_PLUGIN_KEY] ?? true },
  };
}

/**
 * Drops both settings entries and the files setup wrote, and puts the previous `tui` value back unless the user changed it since.
 * Without the record of what install replaced, `tui` is left as it is: it may be the user's own.
 * A foreign marketplace and its plugin entry are left alone.
 */
export async function uninstallActivityPane(settings: Settings, dataDir: string): Promise<Settings> {
  if (marketplaceOwnership(settings, dataDir) === "foreign") return settings;
  const next: Settings = { ...settings };
  for (const [key, entry] of [
    ["extraKnownMarketplaces", MARKETPLACE_NAME],
    ["enabledPlugins", ACTIVITY_PLUGIN_KEY],
  ] as const) {
    if (!(key in settings)) continue;
    const { [entry]: _, ...rest } = entriesOf(settings, key);
    if (Object.keys(rest).length === 0) delete next[key];
    else next[key] = rest;
  }
  if (settings[TUI_KEY] === TUI_FULLSCREEN && existsSync(previousTuiPath(dataDir))) {
    const previous = await readPreviousTui(dataDir);
    if (previous === undefined || previous === null) delete next[TUI_KEY];
    else next[TUI_KEY] = previous;
  }
  const files = [...Object.keys(ownedFiles(dataDir)), previousTuiPath(dataDir)];
  for (const path of files) await rm(path, { force: true });
  await pruneEmptyDirs(files.map(dirname), marketplaceDir(dataDir));
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
