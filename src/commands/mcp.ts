import { homedir } from "node:os";
import { join } from "node:path";
import { applyPrune, envFromProcess, planPrune, revertPrune, type ProjectPlan, type PruneEnv } from "../mcpprune/prune.js";

export interface McpOptions {
  env?: PruneEnv;
  cwd?: string;
  log?: (line: string) => void;
}

export const defaultPruneEnv = (): PruneEnv => ({ home: homedir(), dataDir: join(homedir(), ".project-brain"), ...envFromProcess() });

export function summarize(plans: ProjectPlan[], log: (l: string) => void, windowDays: number): void {
  for (const p of plans) {
    if (p.skipped) log(`${p.project}: skipped (${p.skipped})`);
    else if (p.candidates.length === 0) log(`${p.project}: nothing to disable (${p.sessions} sessions)`);
    else log(`${p.project}: ${p.candidates.map((c) => c.name).join(", ")} (unused in the last ${windowDays} days, ${p.sessions} sessions)`);
  }
}

export async function execute(args: string[], opts: McpOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const [sub, ...rest] = args;
  if (sub !== "prune") {
    log("Usage: project-brain mcp prune [--all] [--apply | --revert]");
    return 1;
  }
  const env = opts.env ?? defaultPruneEnv();

  if (rest.includes("--revert")) {
    const r = await revertPrune(env);
    if (r.error) log(`Revert failed: ${r.error}`);
    else if (r.removed.length === 0) log("Nothing to revert.");
    else for (const e of r.removed) log(`Re-enabled ${e.name} in ${e.project}`);
    return r.error ? 1 : 0;
  }

  const plans = await planPrune(env, rest.includes("--all") ? undefined : [opts.cwd ?? process.cwd()]);
  if (plans.length === 0) {
    log("No known project to look at (is this directory in ~/.claude.json?).");
    return 1;
  }
  if (!rest.includes("--apply")) {
    summarize(plans, log, env.windowDays ?? 30);
    log("\nDry run. Apply with: project-brain mcp prune --apply [--all]");
    return 0;
  }
  const r = await applyPrune(env, plans);
  if (r.error) log(`Apply failed, nothing changed or recorded: ${r.error}`);
  for (const e of r.added) log(`Disabled ${e.name} in ${e.project}`);
  if (r.added.length > 0) log(`\nBackup: ${r.backup}\nUndo with: project-brain mcp prune --revert. Takes effect on the next Claude Code session.`);
  else if (!r.error) log("Nothing to disable.");
  return r.error ? 1 : 0;
}
