import { join } from "node:path";
import { cp, rename, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tableDirName, metaFileName } from "./table-name.js";
import type { TableMeta } from "./meta.js";

export type SeedRefusal =
  | "not-a-worktree"
  | "already-indexed"
  | "no-base-index"
  | "embedding-mismatch"
  | "unverifiable-copy";

export type SeedOutcome = { seeded: true; from: string } | { seeded: false; reason: SeedRefusal };

export interface SeedInputs {
  isMain: boolean;
  worktreeIndexed: boolean;
  baseIndexed: boolean;
  baseMeta: TableMeta | null;
  target: { model?: string; dim: number };
}

/**
 * Whether a worktree may start from its base checkout's index, and why not when it may not.
 *
 * A worktree is a branch of a tree that is already indexed, so nearly every file in it
 * hashes to what the base already embedded. Sync proves that per file — it re-reads and
 * re-hashes everything whose mtime moved, which a fresh checkout makes true of every file,
 * and only embeds what actually differs. Seeding is therefore an optimisation that cannot
 * change the result: a stale or wrong-branch base costs a few extra embeds, never a wrong
 * index.
 *
 * The mismatch refusal is the exception, because it is not self-correcting. Vectors from
 * another model are not comparable with the ones this run would produce, and sync has no
 * reason to revisit a file whose hash still matches — the mismatch would survive.
 */
export function decideSeed(inputs: SeedInputs): SeedRefusal | null {
  if (inputs.isMain) return "not-a-worktree";
  if (inputs.worktreeIndexed) return "already-indexed";
  if (!inputs.baseIndexed || !inputs.baseMeta) return "no-base-index";

  const { model, dim } = inputs.baseMeta;
  if (dim !== inputs.target.dim) return "embedding-mismatch";
  if (inputs.target.model && model !== inputs.target.model) return "embedding-mismatch";

  return null;
}

export interface SeedOptions {
  /** Where the vector tables live — `DB_PATH`, not the data root above it. */
  dbPath: string;
  baseRoot: string;
  worktreeRoot: string;
  baseProject: string;
  worktreeProject: string;
  isMain: boolean;
  target: { model?: string; dim: number };
  /** Proves the copied table opens and answers, so a torn copy never survives. */
  verify?: (project: string) => Promise<boolean>;
}

const CONFIG_DIR = ".project-brain";
const MANIFEST_DB = "manifest.db";
const GRAPH_DB = "graph.db";

async function readMeta(path: string): Promise<TableMeta | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as TableMeta;
  } catch {
    return null;
  }
}

/**
 * Copy a SQLite file the way SQLite itself would.
 *
 * A plain file copy of a database another process is writing can tear a page, and copying
 * the `.db` without its `-wal` silently drops every committed write still in the log.
 * `VACUUM INTO` takes a read lock and writes one consistent, already-checkpointed file.
 */
function copyDatabase(from: string, to: string): void {
  const source = new Database(from, { readonly: true });
  try {
    source.run(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
}

/**
 * Give a new worktree its base checkout's index instead of building one from nothing.
 *
 * Every path stored in the three artefacts is repository-relative — chunk sources, manifest
 * rows, graph files — so they describe any checkout of the repository equally well. That is
 * what makes the copy meaningful rather than a trick.
 *
 * The table lands under a temporary name and is renamed into place once it verifies, so an
 * interrupted copy leaves nothing a later run would mistake for a real index.
 */
export async function seedWorktreeIndex(options: SeedOptions): Promise<SeedOutcome> {
  const { dbPath, baseRoot, worktreeRoot, baseProject, worktreeProject } = options;

  const baseTable = join(dbPath, tableDirName(baseProject));
  const baseMetaPath = join(dbPath, metaFileName(baseProject));
  const baseManifest = join(baseRoot, CONFIG_DIR, MANIFEST_DB);
  const worktreeConfigDir = join(worktreeRoot, CONFIG_DIR);

  const refusal = decideSeed({
    isMain: options.isMain,
    worktreeIndexed: existsSync(join(worktreeConfigDir, MANIFEST_DB)),
    baseIndexed: existsSync(baseTable) && existsSync(baseManifest),
    baseMeta: await readMeta(baseMetaPath),
    target: options.target,
  });
  if (refusal) return { seeded: false, reason: refusal };

  const target = join(dbPath, tableDirName(worktreeProject));
  const staging = `${target}.seeding-${process.pid}`;

  try {
    await rm(staging, { recursive: true, force: true });
    await cp(baseTable, staging, { recursive: true });
    await Bun.write(join(dbPath, metaFileName(worktreeProject)), await Bun.file(baseMetaPath).text());
    await rename(staging, target);

    if (options.verify && !(await options.verify(worktreeProject))) {
      throw new Error("seeded table did not answer");
    }

    await mkdir(worktreeConfigDir, { recursive: true });
    copyDatabase(baseManifest, join(worktreeConfigDir, MANIFEST_DB));

    const baseGraph = join(baseRoot, CONFIG_DIR, GRAPH_DB);
    if (existsSync(baseGraph)) copyDatabase(baseGraph, join(worktreeConfigDir, GRAPH_DB));

    return { seeded: true, from: baseProject };
  } catch {
    await rm(staging, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(join(dbPath, metaFileName(worktreeProject)), { force: true });
    await rm(join(worktreeConfigDir, MANIFEST_DB), { force: true });
    await rm(join(worktreeConfigDir, GRAPH_DB), { force: true });
    return { seeded: false, reason: "unverifiable-copy" };
  }
}
