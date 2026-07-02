import { join } from "node:path";
import { homedir } from "node:os";
import type { AIToolRegistrar } from "./types.js";
import { dirExists, upsertJsonConfig, standardServerEntry } from "./json-config.js";

/**
 * Doc-verified 2026-07 against code.visualstudio.com/docs/agents/reference/mcp-configuration:
 * the user-level MCP config does NOT live under ~/.vscode (that directory is
 * for the CLI shim / extensions). It lives in the platform app-support
 * "Code/User" profile folder, and the entry key is `servers` (not `mcpServers`).
 */
export function defaultVSCodeUserDir(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User");
  }
  return join(home, ".config", "Code", "User");
}

export class VSCodeRegistrar implements AIToolRegistrar {
  name = "VS Code";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? defaultVSCodeUserDir();
  }

  async isInstalled(): Promise<boolean> {
    return dirExists(this.baseDir);
  }

  async register(serverPath: string): Promise<void> {
    await upsertJsonConfig(join(this.baseDir, "mcp.json"), (config) => {
      config.servers ??= {};
      config.servers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  async writeRules(_rulesContent: string): Promise<void> {
    // VS Code has no equivalent rules/instructions directory — no-op.
  }
}
