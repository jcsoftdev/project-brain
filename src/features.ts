import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * The context-economy features, each switched by its own setup unit. All but the opt-in ones are on
 * until the user unticks them; the setup selection is persisted here so hooks can read it at runtime.
 */
export type FeatureId = "task-switch" | "routing-skill" | "search-gate" | "mcp-prune" | "context-slim" | "conceptualize" | "mcp-prune-jev";

type Env = Record<string, string | undefined>;

/** A feature's pre-existing env opt-out: `=0` forces it off whatever the file says. */
const ENV_OFF: Partial<Record<FeatureId, string>> = {
  "task-switch": "PROJECT_BRAIN_TASK_SWITCH",
  "mcp-prune": "PROJECT_BRAIN_MCP_PRUNE",
  conceptualize: "PROJECT_BRAIN_CONCEPTUALIZE",
  "mcp-prune-jev": "PROJECT_BRAIN_MCP_PRUNE_JEV",
};

/** Off until the user ticks them or sets their env variable to `1`: they send data the default features do not. */
const OPT_IN: Partial<Record<FeatureId, string>> = {
  "mcp-prune-jev": "PROJECT_BRAIN_MCP_PRUNE_JEV",
};

const featuresPath = (dataDir: string) => join(dataDir, "features.json");

export const featureEnvOptOut = (id: FeatureId, env: Env = process.env): boolean => {
  const name = ENV_OFF[id];
  return name !== undefined && env[name] === "0";
};

function parse(text: string): Partial<Record<FeatureId, boolean>> {
  try {
    const raw = JSON.parse(text) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Partial<Record<FeatureId, boolean>>) : {};
  } catch {
    return {};
  }
}

/**
 * Synchronous so a hook can ask without ceremony. A missing or unreadable file means every
 * feature is at its default: on, or off for an opt-in one. The env variable wins either way.
 */
export function featureEnabled(id: FeatureId, dataDir: string = DATA_DIR, env: Env = process.env): boolean {
  if (featureEnvOptOut(id, env)) return false;
  const optIn = OPT_IN[id];
  if (optIn !== undefined && env[optIn] === "1") return true;
  let saved: boolean | undefined;
  try {
    saved = parse(readFileSync(featuresPath(dataDir), "utf8"))[id];
  } catch {
    saved = undefined;
  }
  return typeof saved === "boolean" ? saved : optIn === undefined;
}

export async function setFeature(dataDir: string, id: FeatureId, on: boolean): Promise<void> {
  const current = await readFile(featuresPath(dataDir), "utf8").then(parse, () => ({}));
  await mkdir(dataDir, { recursive: true });
  await writeFileAtomic(featuresPath(dataDir), `${JSON.stringify({ ...current, [id]: on }, null, 2)}\n`);
}
