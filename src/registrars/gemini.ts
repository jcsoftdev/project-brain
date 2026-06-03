import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";

export class GeminiRegistrar implements AIToolRegistrar {
  name = "Gemini CLI";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".gemini");
  }

  async isInstalled(): Promise<boolean> {
    return Bun.which("gemini") !== null;
  }

  async register(serverPath: string): Promise<void> {
    const configPath = join(this.baseDir, "settings.json");
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

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "GEMINI.md");
    await writeSection(rulesPath, rulesContent);
  }
}
