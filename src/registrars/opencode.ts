import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
import { dirExists, upsertJsonConfig, standardServerEntry } from "./json-config.js";

export class OpencodeRegistrar implements AIToolRegistrar {
  name = "Opencode";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".config", "opencode");
  }

  async isInstalled(): Promise<boolean> {
    return dirExists(this.baseDir);
  }

  async register(serverPath: string): Promise<void> {
    await upsertJsonConfig(join(this.baseDir, "settings.json"), (config) => {
      config.mcpServers ??= {};
      config.mcpServers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  async writeRules(rulesContent: string): Promise<void> {
    await mkdir(join(this.baseDir, "rules"), { recursive: true });
    await writeSection(this.rulesPath(), rulesContent);
  }

  // Model ids are provider-scoped (`provider/model-id`), so no default we could
  // ship would be right for every user — the tiers stay unnamed until they
  // fill them in.
  routing: RoutingDescriptor = {
    hostKey: "opencode",
    mechanism: "agent-definition",
    howToApply:
      "set `model` on the agent in `opencode.json` (or a markdown agent under " +
      "`~/.config/opencode/agents/`), written as `provider/model-id`. Sub-agents with no " +
      "`model` inherit whichever primary invoked them, so leaving it unset is a routing " +
      "decision by default.",
    labelField: null,
    models: DEFAULT_HOST_MODELS.opencode!,
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
