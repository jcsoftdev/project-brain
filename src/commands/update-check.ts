// Hidden `__update-check` subcommand — refreshes the update-notifier cache.
//
// Run detached by the notifier (see src/notifier.ts). Fetches the latest
// published version from the npm registry and writes it to the cache file so the
// NEXT CLI invocation can warn instantly without any network call. Fully
// fail-silent: any network/parse/write error is swallowed so a background
// refresh can never surface an error to the user.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DATA_DIR } from "../constants.js";
import { UPDATE_CACHE_FILE, type UpdateCache } from "../notifier.js";

const REGISTRY_URL = "https://registry.npmjs.org/project-brain/latest";
const FETCH_TIMEOUT_MS = 3000;

/** Fetch the latest published version from the npm registry. Shared with the `update` command. */
export async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const json = (await res.json()) as { version?: unknown };
  return typeof json.version === "string" ? json.version : null;
}

async function defaultWriteCache(cache: UpdateCache): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(UPDATE_CACHE_FILE, JSON.stringify(cache));
}

export interface UpdateCheckDeps {
  fetchLatest?: () => Promise<string | null>;
  writeCache?: (cache: UpdateCache) => void | Promise<void>;
  now?: () => number;
}

/** Fetch the latest version and persist it to the cache. Never throws. */
export async function runUpdateCheck(deps: UpdateCheckDeps = {}): Promise<void> {
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const writeCache = deps.writeCache ?? defaultWriteCache;
  const now = deps.now ?? (() => Date.now());
  try {
    const latest = await fetchLatest();
    if (!latest) return;
    await writeCache({ checkedAt: now(), latest });
  } catch {
    /* fail-silent — background best-effort refresh */
  }
}

/** CLI entry for the hidden `__update-check` command. */
export async function execute(): Promise<void> {
  await runUpdateCheck();
}
