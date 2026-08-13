import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
import { dirExists, upsertJsonConfig, standardServerEntry } from "./json-config.js";

export class WindsurfRegistrar implements AIToolRegistrar {
  name = "Windsurf";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".codeium", "windsurf");
  }

  async isInstalled(): Promise<boolean> {
    return dirExists(this.baseDir);
  }

  async register(serverPath: string): Promise<void> {
    await upsertJsonConfig(join(this.baseDir, "mcp_config.json"), (config) => {
      config.mcpServers ??= {};
      config.mcpServers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  mcpConfigTarget(): { path: string; containerKey: string } {
    return { path: join(this.baseDir, "mcp_config.json"), containerKey: "mcpServers" };
  }

  async writeRules(rulesContent: string): Promise<void> {
    await mkdir(join(this.baseDir, "rules"), { recursive: true });
    await writeSection(this.rulesPath(), rulesContent);
  }

  // Windsurf became Devin Desktop in June 2026 and Cascade reached EOL a month
  // later; Devin Local routes tiers on its own. Naming models here would be
  // guessing at a lineup that is still moving.
  routing: RoutingDescriptor = {
    hostKey: "windsurf",
    mechanism: "agent-definition",
    howToApply:
      "the local agent picks a tier on its own — strongest reasoning model for plan and " +
      "refactor work, a cheaper tier for high-frequency low-risk edits. Where it exposes an " +
      "explicit model choice for a sub-agent, set it from the table above.",
    labelField: null,
    models: DEFAULT_HOST_MODELS.windsurf!,
  };

  async writtenRoutingVersion(): Promise<number | null> {
    return readWrittenRoutingVersion(this.rulesPath());
  }

  async writeModelRouting(content: string): Promise<void> {
    await mkdir(join(this.baseDir, "rules"), { recursive: true });
    await writeRoutingSection(this.rulesPath(), content);
  }

  private rulesPath(): string {
    return join(this.baseDir, "rules", "project-brain.md");
  }
}
