import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection, hasSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";
import { upsertJsonConfig, standardServerEntry } from "./json-config.js";

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
    return Bun.which("claude") !== null;
  }

  async register(serverPath: string): Promise<void> {
    // Try CLI first; fall back to direct JSON write if it fails.
    const cliSuccess = await this.cliRunner(serverPath);
    if (!cliSuccess) {
      await this.fallbackJsonWrite(serverPath);
    }
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "CLAUDE.md");
    await writeSection(rulesPath, rulesContent);
  }

  async hasModelRouting(): Promise<boolean> {
    const rulesPath = join(this.baseDir, "CLAUDE.md");
    return hasSection(rulesPath, "project-brain-model-routing");
  }

  async writeModelRouting(content: string): Promise<void> {
    const rulesPath = join(this.baseDir, "CLAUDE.md");
    await writeSection(rulesPath, content, "project-brain-model-routing");
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

/** Default runner: spawns the real `claude` CLI to register the server. */
async function defaultCliRunner(serverPath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        "claude",
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "project-brain",
        "--",
        "bun",
        serverPath,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
