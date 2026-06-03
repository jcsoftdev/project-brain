import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";

/** Registers the MCP server via the claude CLI. Returns true on success. */
export type ClaudeCliRunner = (serverPath: string) => Promise<boolean>;

export class ClaudeRegistrar implements AIToolRegistrar {
  name = "Claude Code";
  private baseDir: string;
  private cliRunner: ClaudeCliRunner;

  constructor(baseDir?: string, cliRunner?: ClaudeCliRunner) {
    this.baseDir = baseDir ?? join(homedir(), ".claude");
    this.cliRunner = cliRunner ?? defaultCliRunner;
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

  private async fallbackJsonWrite(serverPath: string): Promise<void> {
    const configPath = join(this.baseDir, "claude.json");
    let config: any = {};

    try {
      config = JSON.parse(await Bun.file(configPath).text());
    } catch {
      // File doesn't exist or invalid JSON
    }

    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers["project-brain"] = {
      command: "bun",
      args: [serverPath],
      transport: "stdio",
    };

    await Bun.write(configPath, JSON.stringify(config, null, 2));
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
