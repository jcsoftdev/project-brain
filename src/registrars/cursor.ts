import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";

export class CursorRegistrar implements AIToolRegistrar {
  name = "Cursor";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".cursor");
  }

  async isInstalled(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["test", "-d", this.baseDir], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  async register(serverPath: string): Promise<void> {
    const configPath = join(this.baseDir, "mcp.json");
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
    const rulesDir = join(this.baseDir, "rules");
    await mkdir(rulesDir, { recursive: true });
    const rulesPath = join(rulesDir, "project-brain.md");
    await writeSection(rulesPath, rulesContent);
  }
}
