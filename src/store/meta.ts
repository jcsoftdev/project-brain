import { join } from "node:path";

export interface TableMeta { model: string; dim: number; }

function metaPath(dbPath: string, project: string): string {
  const safe = project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
  return join(dbPath, `${safe}.meta.json`);
}

/**
 * In-memory cache of meta reads, keyed by `${dbPath}:${project}`. All readers
 * (embeddings resolver, assertDim, listProjects) go through readTableMeta, so
 * caching here benefits everyone and invalidation stays colocated with the
 * writes that can actually change the value (writeTableMeta / deleteTableMeta).
 * `null` is a valid cached value (meta genuinely absent) — presence in the Map
 * is what distinguishes "cached" from "not yet read", so we can't use `?? `.
 */
const metaCache = new Map<string, TableMeta | null>();

function cacheKey(dbPath: string, project: string): string {
  return `${dbPath}:${project}`;
}

export async function readTableMeta(dbPath: string, project: string): Promise<TableMeta | null> {
  const key = cacheKey(dbPath, project);
  if (metaCache.has(key)) {
    return metaCache.get(key)!;
  }
  const f = Bun.file(metaPath(dbPath, project));
  let result: TableMeta | null;
  if (!(await f.exists())) {
    result = null;
  } else {
    try { result = (await f.json()) as TableMeta; } catch { result = null; }
  }
  metaCache.set(key, result);
  return result;
}

export async function writeTableMeta(dbPath: string, project: string, meta: TableMeta): Promise<void> {
  await Bun.write(metaPath(dbPath, project), JSON.stringify(meta));
  metaCache.set(cacheKey(dbPath, project), meta);
}

export async function deleteTableMeta(dbPath: string, project: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(metaPath(dbPath, project)); } catch {}
  metaCache.delete(cacheKey(dbPath, project));
}
