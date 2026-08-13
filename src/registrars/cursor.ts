import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
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

  mcpConfigTarget(): { path: string; containerKey: string } {
    return { path: join(this.baseDir, "mcp.json"), containerKey: "mcpServers" };
  }

  async writeRules(rulesContent: string): Promise<void> {
    await mkdir(join(this.baseDir, "rules"), { recursive: true });
    await writeSection(this.rulesPath(), rulesContent);
  }

  // Cursor exposes a literal `fast` tier by name; anything deeper is `inherit`
  // or a pinned id, which is the user's call, not ours.
  routing: RoutingDescriptor = {
    hostKey: "cursor",
    mechanism: "agent-definition",
    howToApply:
      "set the sub-agent's model field to `fast`, `inherit`, or a pinned model id. " +
      "`is_background: true` makes it async — the parent continues and the sub-agent writes " +
      "progress under `~/.cursor/subagents/`. Its `description` is the routing signal the " +
      "parent reads when deciding to delegate at all, so write it to be matched.",
    labelField: null,
    models: DEFAULT_HOST_MODELS.cursor!,
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
