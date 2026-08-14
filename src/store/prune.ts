import { existsSync } from "node:fs";
import { TABLE_SUFFIX } from "../constants.js";
import type { ProjectRegistry } from "./project-registry.js";

/**
 * Why a table is a prune candidate.
 *
 * `root-missing` — the registry still attributes this table to a project whose
 * root is gone. Actionable, once the grace window has passed.
 *
 * `unknown-provenance` — no registry entry claims this table. NOT evidence of
 * an orphan: projects indexed before the registry existed have no entry, and at
 * least one such project (`sessions`) is live, served, and in daily use. These
 * are reported so a human can judge them, and are never auto-deleted.
 */
export type PruneReason = "root-missing" | "unknown-provenance";

export interface PruneCandidate {
  /** Project id as recorded, or derived from the table name. */
  project: string;
  table: string;
  reason: PruneReason;
  root?: string;
  missingSince?: number;
  /** Safe to delete without a human looking at it. */
  eligible: boolean;
}

export interface ClassifyOptions {
  now: number;
  /** How long a root must stay missing before its data may be deleted. */
  graceMs: number;
  /** Injected for tests; defaults to a real filesystem check. */
  rootExists?: (path: string) => boolean;
}

/**
 * Decide which stored tables are reclaimable.
 *
 * Pure and filesystem-injectable, because the cost of getting this wrong is
 * deleting someone's index: absence of a root is not proof of deletion (an
 * unmounted volume looks identical), and absence of a registry entry is not
 * proof of anything at all.
 */
export function classifyTables(
  tables: string[],
  registry: ProjectRegistry,
  opts: ClassifyOptions
): PruneCandidate[] {
  const rootExists = opts.rootExists ?? existsSync;
  const out: PruneCandidate[] = [];

  for (const table of tables) {
    if (!table.endsWith(TABLE_SUFFIX)) continue;
    const derived = table.slice(0, -TABLE_SUFFIX.length);

    const match = Object.entries(registry).find(
      ([id]) => sanitize(id) === derived
    );

    if (!match) {
      out.push({
        project: derived,
        table,
        reason: "unknown-provenance",
        eligible: false,
      });
      continue;
    }

    const [project, entry] = match;
    if (rootExists(entry.root)) continue; // live project — nothing to do

    // No stamp means an older build recorded this entry. Start the clock on the
    // next registration rather than deleting the moment we first notice.
    const eligible =
      typeof entry.missingSince === "number" &&
      opts.now - entry.missingSince > opts.graceMs;

    out.push({
      project,
      table,
      reason: "root-missing",
      root: entry.root,
      missingSince: entry.missingSince,
      eligible,
    });
  }

  return out;
}

/** Mirrors LanceDbStore's table-name derivation. */
function sanitize(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
}

/** The subset of the store pruning needs — keeps this testable without LanceDB. */
export interface PrunableStore {
  listTables(): Promise<string[]>;
  deleteProject(project: string): Promise<boolean>;
}

export interface PruneOptions extends ClassifyOptions {
  /** Report what would be deleted without touching anything. */
  dryRun?: boolean;
  /**
   * Opt in to considering unregistered tables. Even then they are only
   * reported: no flag makes it safe to drop an index the registry cannot
   * account for, because a live pre-registry project looks exactly like one.
   */
  includeUnknown?: boolean;
}

export interface PruneReport {
  deleted: PruneCandidate[];
  skipped: PruneCandidate[];
  failed: PruneCandidate[];
}

/**
 * Delete the storage of projects whose roots are long gone.
 *
 * One failure never stops the sweep: a table held open by another process is a
 * normal condition here, not a reason to leave the rest of the garbage behind.
 */
export async function pruneOrphans(
  store: PrunableStore,
  registry: ProjectRegistry,
  opts: PruneOptions
): Promise<PruneReport> {
  const tables = await store.listTables();
  const candidates = classifyTables(tables, registry, opts);

  const report: PruneReport = { deleted: [], skipped: [], failed: [] };

  for (const candidate of candidates) {
    if (!candidate.eligible) {
      report.skipped.push(candidate);
      continue;
    }
    if (opts.dryRun) {
      report.deleted.push(candidate);
      continue;
    }
    try {
      await store.deleteProject(candidate.project);
      report.deleted.push(candidate);
    } catch {
      report.failed.push(candidate);
    }
  }

  return report;
}

/**
 * How long a project's root must stay missing before its stored data may be
 * deleted. Long enough that an unmounted drive, a checked-out branch or a
 * machine move is not mistaken for a deletion.
 */
export const ORPHAN_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
