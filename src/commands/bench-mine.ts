import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { mineQueries, formatQueriesJsonl, type MineOptions, type MineStats } from "../bench/mine.js";
import { parseStringFlag } from "../cli-args.js";

const DEFAULT_OUT = ".project-brain/bench/queries.jsonl";

export interface BenchMineDeps {
  /** DI seam for tests — same signature as mineQueries. */
  mine: (opts: MineOptions) => ReturnType<typeof mineQueries>;
}

const defaultDeps: BenchMineDeps = { mine: mineQueries };

const STAT_LABELS: Array<[keyof MineStats, string]> = [
  ["scanned", "non-merge commits scanned"],
  ["afterNoiseSubject", "after dropping release/version-bump subjects"],
  ["afterFileCountBound", "after dropping mass edits (file-count cap)"],
  ["afterNoisePath", "after dropping lockfile/manifest-only commits"],
  ["afterIndexFilter", "after dropping unindexed gold files"],
  ["afterSurvivalFilter", "after dropping temporal drift (survival filter)"],
];

function printFunnel(stats: MineStats): void {
  console.log("bench mine: filter funnel");
  for (const [key, label] of STAT_LABELS) {
    console.log(`  ${String(stats[key]).padStart(4)}  ${label}`);
  }
}

/** CLI entry point for `project-brain bench mine`. */
export async function execute(args: string[], deps: BenchMineDeps = defaultDeps): Promise<void> {
  const outPath = parseStringFlag(args, "--out") ?? DEFAULT_OUT;
  const limitRaw = parseStringFlag(args, "--limit");
  const limit = limitRaw !== undefined ? Math.max(1, parseInt(limitRaw, 10) || 1) : undefined;
  const minSurvivalRaw = parseStringFlag(args, "--min-survival");
  const minSurvival = minSurvivalRaw !== undefined ? Number(minSurvivalRaw) : undefined;

  let queries;
  try {
    queries = deps.mine({ limit, minSurvival, onStats: printFunnel });
  } catch (err) {
    console.error(`bench mine: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (queries.length === 0) {
    console.log("bench mine: no commits survived the filters — nothing written.");
    return;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, formatQueriesJsonl(queries), "utf-8");

  console.log(`bench mine: wrote ${queries.length} queries to ${outPath}`);
}
