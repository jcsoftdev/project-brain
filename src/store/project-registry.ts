import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";

/** Filename, under the global data dir, holding the project id → root map. */
export const PROJECTS_FILE = "projects.json";

export interface ProjectEntry {
  /** Absolute filesystem root of the project. */
  root: string;
  /** Epoch ms of the last registration. */
  updatedAt: number;
  /**
   * Epoch ms when this project's root was first observed missing, or absent
   * while it is present. A grace window on this is what separates a deleted
   * repo from a temporarily unmounted volume.
   */
  missingSince?: number;
}

export type ProjectRegistry = Record<string, ProjectEntry>;

/**
 * Map project ids to their filesystem roots.
 *
 * The vector store is one global multi-project LanceDB, so every semantic tool
 * takes a `project` argument. The structural graph is the opposite: a
 * project-LOCAL `<root>/.project-brain/graph.db`. Without a way to turn a
 * project id back into a root, the structural tools could only ever answer for
 * the one root their server process was started in. This file is that map.
 *
 * Every function here is failure-tolerant by design: registration piggybacks on
 * `init`/`sync`, and a registry problem must never break an indexing run.
 */
function isEntry(value: unknown): value is ProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ProjectEntry>;
  return typeof entry.root === "string" && entry.root.length > 0;
}

/** Read the registry, dropping malformed entries. Returns {} on any failure. */
export async function readRegistry(dataDir: string): Promise<ProjectRegistry> {
  try {
    const raw = await readFile(join(dataDir, PROJECTS_FILE), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const out: ProjectRegistry = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEntry(value)) {
        const entry: ProjectEntry = {
          root: value.root,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
        };
        if (typeof value.missingSince === "number") entry.missingSince = value.missingSince;
        out[id] = entry;
      }
    }
    return out;
  } catch {
    return {}; // missing / unreadable / malformed — an empty map is the safe answer
  }
}

/**
 * Record (or update) where a project lives. Never throws — a failure here must
 * not abort the init/sync that triggered it.
 */
export async function registerProject(
  dataDir: string,
  projectId: string,
  root: string,
  now: number = Date.now()
): Promise<void> {
  try {
    const registry = await readRegistry(dataDir);

    // Mark — never erase — entries whose root has vanished.
    //
    // This used to `delete` them outright, which had two costs. A root can be
    // absent because a volume is unmounted, not because the project is gone,
    // and the deletion was silent and immediate. Worse, the entry is the only
    // record of which table that data belongs to: erasing it turned a prunable
    // orphan into unattributable storage nobody could safely reclaim.
    //
    // Stamping `missingSince` keeps the attribution and starts a clock that
    // `prune` can act on. The entry being written is exempt — its root is
    // authoritative here.
    for (const [id, entry] of Object.entries(registry)) {
      if (id === projectId) continue;
      if (existsSync(entry.root)) {
        delete entry.missingSince; // came back — an unmount, not a deletion
      } else {
        entry.missingSince ??= now;
      }
    }

    registry[projectId] = { root, updatedAt: now };
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, PROJECTS_FILE), JSON.stringify(registry, null, 2), "utf-8");
  } catch {
    // Best-effort: a project that fails to register simply stays unreachable
    // by id from another root, exactly as it was before this registry existed.
  }
}

/**
 * Resolve a project id to its root, or null when unknown.
 *
 * A recorded root that no longer exists on disk resolves to null: the project
 * was moved or deleted, and pointing callers at a dead path would surface as a
 * confusing empty graph rather than an honest "not found".
 */
export async function lookupProjectRoot(dataDir: string, projectId: string): Promise<string | null> {
  const entry = (await readRegistry(dataDir))[projectId];
  if (!entry) return null;
  return existsSync(entry.root) ? entry.root : null;
}
