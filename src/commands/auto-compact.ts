import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { TABLE_SUFFIX } from "../constants.js";
import type { SpawnFn } from "../bench/mine.js";
import { sanitizeProject } from "../store/table-name.js";

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

const envNumber = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Read per call so a shell override takes effect without re-importing. */
export const autoCompactLimits = () => ({
  /** Below this a table's garbage is not worth the I/O. */
  minBytes: envNumber("BRAIN_AUTO_COMPACT_MIN_MB", 256) * MB,
  /** A table compacted more recently than this is left alone. */
  minIntervalMs: envNumber("BRAIN_AUTO_COMPACT_INTERVAL_HOURS", 24) * HOUR,
  /** A table committed to more recently than this has a live writer. */
  quietMs: envNumber("BRAIN_AUTO_COMPACT_QUIET_MINUTES", 10) * 60 * 1000,
  maxTables: envNumber("BRAIN_AUTO_COMPACT_MAX_TABLES", 2),
  budgetMs: envNumber("BRAIN_AUTO_COMPACT_BUDGET_SECONDS", 60) * 1000,
  /** Versions younger than this survive. Longer than the manual command's 10 minutes. */
  retentionMs: envNumber("BRAIN_AUTO_COMPACT_RETENTION_MINUTES", 30) * 60 * 1000,
});

export interface CompactFacts {
  sizeBytes: number;
  lastModifiedMs: number;
  /** Epoch ms of the last compaction we recorded, or null. */
  lastCompactedAt: number | null;
  now: number;
  /** Pids with the table open; null when the check failed. */
  holders: number[] | null;
  /** The table belongs to the project of the session running this. */
  ownProject: boolean;
}

export type CompactDecision = { compact: true } | { compact: false; reason: string };

/**
 * Whether one table is worth aggressive compaction right now. Every "no" is a
 * safety or economy answer; the lone "yes" requires positive evidence that
 * nobody has the table open.
 */
export function shouldCompact(
  facts: CompactFacts,
  limits: Pick<ReturnType<typeof autoCompactLimits>, "minBytes" | "minIntervalMs" | "quietMs"> = autoCompactLimits()
): CompactDecision {
  if (facts.ownProject) return { compact: false, reason: "belongs to the running session" };
  if (facts.sizeBytes < limits.minBytes) return { compact: false, reason: "below size threshold" };
  if (facts.lastCompactedAt !== null && facts.now - facts.lastCompactedAt < limits.minIntervalMs) {
    return { compact: false, reason: "compacted recently" };
  }
  if (facts.now - facts.lastModifiedMs < limits.quietMs) return { compact: false, reason: "written to recently" };
  if (facts.holders === null) return { compact: false, reason: "holder check failed" };
  if (facts.holders.length > 0) return { compact: false, reason: `in use by process ${facts.holders.join(", ")}` };
  return { compact: true };
}

/**
 * Pids with a file open inside `path`, or null when that cannot be established.
 *
 * lsof exits 1 with no output both for "nothing open" and for some failures, so
 * only a clean 0/1 exit with empty stderr counts as free. Anything else is unknown.
 */
export function lsofTableHolders(
  path: string,
  selfPid: number = process.pid,
  spawn: SpawnFn = spawnSync
): number[] | null {
  const r = spawn("lsof", ["-Fp", "+D", path], { encoding: "utf-8", timeout: 20_000, maxBuffer: 16 * MB });
  if (r.error || r.signal || typeof r.stdout !== "string" || typeof r.stderr !== "string") return null;
  if (r.status !== 0 && r.status !== 1) return null;
  if (r.stderr.trim().length > 0) return null;
  const pids = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("p"))
    .map((l) => Number(l.slice(1)));
  if (r.status === 1 && pids.length > 0) return null;
  return [...new Set(pids)].filter((p) => p !== selfPid);
}

export interface TableInfo {
  /** Sanitized project key, as the store derives the table from it. */
  project: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface AutoCompactDeps {
  listTables: () => Promise<TableInfo[]>;
  holders: (project: string) => number[] | null;
  /** Sanitized key of the cwd project, or null outside one. */
  ownProject: string | null;
  now: () => number;
  /** Compacts one table and returns the bytes it freed. */
  compact: (project: string) => Promise<number>;
  readRecord: () => Promise<Record<string, number>>;
  writeRecord: (record: Record<string, number>) => Promise<void>;
  limits?: ReturnType<typeof autoCompactLimits>;
}

export interface AutoCompactResult {
  compacted: string[];
  reclaimedBytes: number;
}

const safely = <T>(fn: () => T | null): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/**
 * Compact the largest eligible tables, within a table cap and a wall budget
 * checked between tables. Never throws: this runs inside a host's hook.
 */
export async function autoCompact(deps: AutoCompactDeps): Promise<AutoCompactResult> {
  const result: AutoCompactResult = { compacted: [], reclaimedBytes: 0 };
  try {
    const limits = deps.limits ?? autoCompactLimits();
    const started = deps.now();
    const record = await deps.readRecord().catch(() => ({}) as Record<string, number>);
    const tables = (await deps.listTables()).sort((a, b) => b.sizeBytes - a.sizeBytes);

    for (const table of tables) {
      if (result.compacted.length >= limits.maxTables) break;
      if (deps.now() - started >= limits.budgetMs) break;

      const decision = shouldCompact(
        {
          sizeBytes: table.sizeBytes,
          lastModifiedMs: table.lastModifiedMs,
          lastCompactedAt: record[table.project] ?? null,
          now: deps.now(),
          holders: safely(() => deps.holders(table.project)),
          ownProject: table.project === deps.ownProject,
        },
        limits
      );
      if (!decision.compact) continue;

      try {
        result.reclaimedBytes += Math.max(0, await deps.compact(table.project));
        result.compacted.push(table.project);
        record[table.project] = deps.now();
        await deps.writeRecord(record);
      } catch {
        // One table failing (lock held, lance error) must not cost the others their turn.
      }
    }
  } catch {
    // Reporting what was done so far beats failing the host.
  }
  return result;
}

export function summarize(result: AutoCompactResult): string | null {
  if (result.reclaimedBytes <= 0) return null;
  const gb = (result.reclaimedBytes / 1e9).toFixed(2);
  return `project-brain: reclaimed ${gb} GB from ${result.compacted.length} index(es)`;
}

export async function dirSize(path: string): Promise<number> {
  const proc = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim().split(/\s+/)[0] ?? 0) * 1024;
}

export const COMPACTION_RECORD_FILE = "compaction.json";

export const tablePath = (dbPath: string, project: string): string =>
  join(dbPath, `${sanitizeProject(project)}${TABLE_SUFFIX}.lance`);

/** Lance commits by writing under `_versions` and `data`, which moves those directories' mtimes, not the root's. */
async function lastCommitMs(path: string): Promise<number> {
  const mtimes = await Promise.all(
    ["", "_versions", "_transactions", "data"].map((sub) =>
      stat(join(path, sub)).then((s) => s.mtimeMs, () => 0)
    )
  );
  return Math.max(...mtimes);
}

/** Real dependencies over a data layout (`dbPath` holds the tables, `dataDir` the record). */
export function defaultAutoCompactDeps(opts: {
  dbPath: string;
  dataDir: string;
  ownProject: string | null;
  holders?: (path: string) => number[] | null;
  compactTable?: (project: string, retentionMs: number) => Promise<void>;
}): AutoCompactDeps {
  const limits = autoCompactLimits();
  const recordFile = join(opts.dataDir, COMPACTION_RECORD_FILE);
  const suffix = `${TABLE_SUFFIX}.lance`;
  const holders = opts.holders ?? ((p: string) => lsofTableHolders(p));
  const compactTable =
    opts.compactTable ??
    (async (project: string, retentionMs: number) => {
      const { LanceDbStore } = await import("../store/lancedb.js");
      await new LanceDbStore(opts.dbPath).compactAggressively(project, retentionMs);
    });

  const deps: AutoCompactDeps = {
    limits,
    ownProject: opts.ownProject,
    now: Date.now,
    holders: (project) => holders(tablePath(opts.dbPath, project)),
    listTables: async () => {
      const names = (await readdir(opts.dbPath)).filter((n) => n.endsWith(suffix));
      return Promise.all(
        names.map(async (name) => {
          const path = join(opts.dbPath, name);
          return {
            project: name.slice(0, -suffix.length),
            sizeBytes: await dirSize(path),
            lastModifiedMs: await lastCommitMs(path),
          };
        })
      );
    },
    compact: async (project) => {
      const path = tablePath(opts.dbPath, project);
      const before = await dirSize(path);
      await compactTable(project, (deps.limits ?? limits).retentionMs);
      return before - (await dirSize(path));
    },
    readRecord: async () => {
      try {
        return JSON.parse(await readFile(recordFile, "utf-8")) as Record<string, number>;
      } catch {
        return {};
      }
    },
    writeRecord: async (record) => {
      await writeFileAtomic(recordFile, JSON.stringify(record));
    },
  };
  return deps;
}
