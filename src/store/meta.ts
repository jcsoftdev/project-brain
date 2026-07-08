import { join } from "node:path";
import { stat } from "node:fs/promises";

export interface TableMeta { model: string; dim: number; }

function metaPath(dbPath: string, project: string): string {
  const safe = project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
  return join(dbPath, `${safe}.meta.json`);
}

interface CacheEntry { value: TableMeta | null; mtimeMs: number | null; }

/**
 * In-memory cache of meta reads, keyed by `${dbPath}:${project}`. All readers
 * (embeddings resolver, assertDim, listProjects) go through readTableMeta, so
 * caching here benefits everyone and invalidation stays colocated with the
 * writes that can actually change the value (writeTableMeta / deleteTableMeta).
 *
 * Each entry also stores the meta file's mtimeMs at the time it was cached
 * (`null` when the file didn't exist). Every read re-`stat`s the file and
 * compares mtimeMs — if it differs (or the stat fails, e.g. the file was
 * deleted) the cache entry is invalidated and re-read from disk. This makes
 * writes from OTHER processes (e.g. a separate `project-brain reindex` run
 * switching embedding models) visible to a long-lived `serve` process,
 * while keeping the common case cheap (a stat instead of a read+JSON.parse).
 */
const metaCache = new Map<string, CacheEntry>();

function cacheKey(dbPath: string, project: string): string {
  return `${dbPath}:${project}`;
}

async function currentMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export async function readTableMeta(dbPath: string, project: string): Promise<TableMeta | null> {
  const key = cacheKey(dbPath, project);
  const path = metaPath(dbPath, project);
  const cached = metaCache.get(key);
  if (cached) {
    const mtimeMs = await currentMtimeMs(path);
    if (mtimeMs !== null && mtimeMs === cached.mtimeMs) {
      return cached.value;
    }
    // mtime differs, or stat failed (file removed) while cache says it existed — fall through to re-read.
  }
  const f = Bun.file(path);
  let result: TableMeta | null;
  if (!(await f.exists())) {
    result = null;
  } else {
    try { result = (await f.json()) as TableMeta; } catch { result = null; }
  }
  const mtimeMs = await currentMtimeMs(path);
  metaCache.set(key, { value: result, mtimeMs });
  return result;
}

export async function writeTableMeta(dbPath: string, project: string, meta: TableMeta): Promise<void> {
  const path = metaPath(dbPath, project);
  await Bun.write(path, JSON.stringify(meta));
  const mtimeMs = await currentMtimeMs(path);
  metaCache.set(cacheKey(dbPath, project), { value: meta, mtimeMs });
}

export async function deleteTableMeta(dbPath: string, project: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(metaPath(dbPath, project)); } catch {}
  metaCache.delete(cacheKey(dbPath, project));
}
