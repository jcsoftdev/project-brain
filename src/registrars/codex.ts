import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
import { resolveBinary } from "../env/resolve-binary.js";
import { launchCommand } from "./json-config.js";

/**
 * The argv for `codex mcp add`. Extracted from the spawn call so the launch
 * command after `--` is assertable without spawning the real CLI.
 */
export function buildCodexAddArgv(
  codexBin: string,
  serverPath: string
): string[] {
  const { command, args } = launchCommand(serverPath);
  return [codexBin, "mcp", "add", "project-brain", "--", command, ...args];
}

export class CodexRegistrar implements AIToolRegistrar {
  name = "Codex";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".codex");
  }

  async isInstalled(): Promise<boolean> {
    return (await resolveBinary("codex")) !== null;
  }

  async register(serverPath: string): Promise<void> {
    try {
      // Resolved path, not the bare name — see the note in claude.ts.
      const codexBin = (await resolveBinary("codex")) ?? "codex";
      const proc = Bun.spawn(buildCodexAddArgv(codexBin, serverPath), {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`[Codex] CLI registration failed: ${stderr.trim()}`);
      }
    } catch (e: any) {
      console.warn(`[Codex] CLI not available: ${e.message}`);
    }
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "instructions.md");
    await writeSection(rulesPath, rulesContent);
  }

  // One flagship model: depth here comes from reasoning effort, not a third
  // model. Per-spawn selection was removed after v5.6 and only returns behind
  // an opt-in feature flag, so the agent file is the reliable route.
  routing: RoutingDescriptor = {
    hostKey: "codex",
    mechanism: "agent-definition",
    howToApply:
      "pin the model in the agent's TOML under `~/.codex/agents/`. Without " +
      "`[features.multi_agent_v2]` in `~/.codex/config.toml`, sub-agents inherit the parent's " +
      "model and the spawn call cannot override it. Reach `deep` by raising " +
      "`model_reasoning_effort`, not by switching model.",
    labelField: null,
    models: DEFAULT_HOST_MODELS.codex!,
  };

  async writtenRoutingVersion(): Promise<number | null> {
    return readWrittenRoutingVersion(join(this.baseDir, "instructions.md"));
  }

  async writeModelRouting(content: string): Promise<void> {
    await writeRoutingSection(join(this.baseDir, "instructions.md"), content);
  }
}
