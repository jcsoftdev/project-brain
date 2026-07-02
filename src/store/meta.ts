import { join } from "node:path";

export interface TableMeta { model: string; dim: number; }

function metaPath(dbPath: string, project: string): string {
  const safe = project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
  return join(dbPath, `${safe}.meta.json`);
}

export async function readTableMeta(dbPath: string, project: string): Promise<TableMeta | null> {
  const f = Bun.file(metaPath(dbPath, project));
  if (!(await f.exists())) return null;
  try { return (await f.json()) as TableMeta; } catch { return null; }
}

export async function writeTableMeta(dbPath: string, project: string, meta: TableMeta): Promise<void> {
  await Bun.write(metaPath(dbPath, project), JSON.stringify(meta));
}

export async function deleteTableMeta(dbPath: string, project: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(metaPath(dbPath, project)); } catch {}
}
