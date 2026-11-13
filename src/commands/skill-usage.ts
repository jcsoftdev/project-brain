import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";
import { capLogFile, INTERACTIVE_LOG_FILE } from "../setup/log-cap.js";
import { refreshSkillUsage, scanSkillUsage, skillUsagePath, type SkillUsage } from "../skills/usage.js";

export interface SkillUsageDeps {
  dataDir?: string;
  projectsRoot?: string;
  log?: (line: string) => void;
}

const USAGE = "Usage: project-brain skill-usage [--write [--if-stale]] [--json]";

function render(usage: SkillUsage): string[] {
  const rows = Object.entries(usage.skills).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const { files, bytes, truncated } = usage.scanned;
  return [
    `Skill invocations in the last ${usage.windowDays} days (${files} transcripts, ${(bytes / 1024 ** 2).toFixed(0)} MB${truncated ? ", stopped at the byte budget" : ""}):`,
    ...rows.map(([name, { count, lastUsed }]) => `  ${String(count).padStart(5)}  ${new Date(lastUsed).toISOString().slice(0, 10)}  ${name}`),
  ];
}

/**
 * `project-brain skill-usage`: counts Skill tool calls and slash commands in recent Claude Code
 * transcripts. Read-only unless `--write`, which saves `~/.project-brain/skill-usage.json` for the
 * compact skill listing; `--if-stale` skips that when the file is under a day old.
 */
export async function execute(args: string[], deps: SkillUsageDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  if (args.includes("--help") || args.includes("-h")) return log(USAGE);
  const dataDir = deps.dataDir ?? DATA_DIR;
  const projectsRoot = deps.projectsRoot ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

  if (!args.includes("--write")) {
    const usage = await scanSkillUsage({ projectsRoot });
    for (const line of args.includes("--json") ? [JSON.stringify(usage, null, 2)] : render(usage)) log(line);
    return;
  }
  const written = await refreshSkillUsage({ dataDir, projectsRoot, maxAgeMs: args.includes("--if-stale") ? undefined : 0 });
  // The listing mod runs this at every session start, which makes it the one
  // reliable recurring hook for capping the interactive Ollama's service log.
  await capLogFile(join(dataDir, INTERACTIVE_LOG_FILE)).catch(() => null);
  if (written) log(`Wrote ${skillUsagePath(dataDir)}: ${Object.keys(written.skills).length} names.`);
}
