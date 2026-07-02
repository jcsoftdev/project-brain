import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";
import { upsertJsonConfig, standardServerEntry } from "./json-config.js";

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
    await upsertJsonConfig(join(this.baseDir, "settings.json"), (config) => {
      config.mcpServers ??= {};
      config.mcpServers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "GEMINI.md");
    await writeSection(rulesPath, rulesContent);
  }
}
