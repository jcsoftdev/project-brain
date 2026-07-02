import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";
import { dirExists, upsertJsonConfig, standardServerEntry } from "./json-config.js";

export class CursorRegistrar implements AIToolRegistrar {
  name = "Cursor";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".cursor");
  }

  async isInstalled(): Promise<boolean> {
    return dirExists(this.baseDir);
  }

  async register(serverPath: string): Promise<void> {
    await upsertJsonConfig(join(this.baseDir, "mcp.json"), (config) => {
      config.mcpServers ??= {};
      config.mcpServers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesDir = join(this.baseDir, "rules");
    await mkdir(rulesDir, { recursive: true });
    const rulesPath = join(rulesDir, "project-brain.md");
    await writeSection(rulesPath, rulesContent);
  }
}
