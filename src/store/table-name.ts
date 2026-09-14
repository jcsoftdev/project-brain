import { TABLE_SUFFIX } from "../constants.js";

/**
 * How a project id becomes the names its storage lives under.
 *
 * The vector table and its meta file must agree on this exactly. They were spelled out
 * separately in `lancedb.ts` and `meta.ts`, which meant a project id could resolve to a
 * table under one rule and to a meta file under another — a mismatch that reads as an
 * unindexed project rather than as a bug.
 */
export function sanitizeProject(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
}

export function tableName(project: string): string {
  return `${sanitizeProject(project)}${TABLE_SUFFIX}`;
}

/** The directory LanceDB gives that table on disk. */
export function tableDirName(project: string): string {
  return `${tableName(project)}.lance`;
}

export function metaFileName(project: string): string {
  return `${sanitizeProject(project)}.meta.json`;
}
