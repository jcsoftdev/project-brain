import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
import {
  upsertJsonConfig,
  standardServerEntry,
  launchCommand,
} from "./json-config.js";
import { resolveBinary } from "../env/resolve-binary.js";

/** Registers the MCP server via the claude CLI. Returns true on success. */
export type ClaudeCliRunner = (serverPath: string) => Promise<boolean>;

export class ClaudeRegistrar implements AIToolRegistrar {
  name = "Claude Code";
  private baseDir: string;
  private cliRunner: ClaudeCliRunner;
  private homeDir: string;

  constructor(baseDir?: string, cliRunner?: ClaudeCliRunner, homeDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".claude");
    this.cliRunner = cliRunner ?? defaultCliRunner;
    this.homeDir = homeDir ?? homedir();
  }

  async isInstalled(): Promise<boolean> {
    return (await resolveBinary("claude")) !== null;
  }

  async register(serverPath: string): Promise<void> {
    // Try CLI first; fall back to direct JSON write if it fails.
    const cliSuccess = await this.cliRunner(serverPath);
    if (!cliSuccess) {
      await this.fallbackJsonWrite(serverPath);
    }
  }

  mcpConfigTarget(): { path: string; containerKey: string } {
    return { path: join(this.homeDir, ".claude.json"), containerKey: "mcpServers" };
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "CLAUDE.md");
    await writeSection(rulesPath, rulesContent);
  }

  // The only host with a PER-CALL label: the Agent/Task tool's `description`
  // is chosen at delegation time, so the model can be prefixed into it.
  routing: RoutingDescriptor = {
    hostKey: "claude",
    mechanism: "per-spawn",
    howToApply:
      "pass `model` on the Agent/Task call, or set `model:` in a sub-agent's frontmatter. " +
      "Omit it only when inheriting the session model is the deliberate choice. " +
      "Workflow steps take the same value via `opts.model`, and `opts.effort` for the second axis.",
    labelField: "the Agent tool's `description` (and `opts.label` in Workflow scripts)",
    models: DEFAULT_HOST_MODELS.claude!,
  };

  async writtenRoutingVersion(): Promise<number | null> {
    return readWrittenRoutingVersion(join(this.baseDir, "CLAUDE.md"));
  }

  async writeModelRouting(content: string): Promise<void> {
    await writeRoutingSection(join(this.baseDir, "CLAUDE.md"), content);
  }

  private async fallbackJsonWrite(serverPath: string): Promise<void> {
    // Claude Code's real user-scope MCP config is the dotfile at the HOME
    // ROOT (~/.claude.json) — NOT under baseDir (~/.claude/), which only
    // holds settings.json/CLAUDE.md/projects/. `claude mcp add --scope user`
    // writes to ~/.claude.json, so the fallback must match or it silently
    // no-ops (Claude Code never reads it).
    const configPath = join(this.homeDir, ".claude.json");
    await upsertJsonConfig(configPath, (config) => {
      config.mcpServers ??= {};
      config.mcpServers["project-brain"] = standardServerEntry(serverPath);
    });
  }
}

/**
 * The argv for `claude mcp add`. Extracted from the spawn call so the launch
 * command after `--` is assertable without spawning the real CLI.
 */
export function buildClaudeAddArgv(
  claudeBin: string,
  serverPath: string
): string[] {
  const { command, args } = launchCommand(serverPath);
  return [
    claudeBin,
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    "project-brain",
    "--",
    command,
    ...args,
  ];
}

/** Default runner: spawns the real `claude` CLI to register the server. */
async function defaultCliRunner(serverPath: string): Promise<boolean> {
  try {
    // Spawn the resolved absolute path, not the bare name. A binary found only
    // by the ~/.local/bin fallback is by definition not on PATH, so spawning
    // "claude" would fail and silently drop us into the JSON fallback.
    const claudeBin = await resolveBinary("claude");
    if (!claudeBin) return false;
    const proc = Bun.spawn(buildClaudeAddArgv(claudeBin, serverPath), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
