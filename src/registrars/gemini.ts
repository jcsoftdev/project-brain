import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import { readWrittenRoutingVersion, writeRoutingSection } from "./routing-section.js";
import { DEFAULT_HOST_MODELS } from "../constants.js";
import type { AIToolRegistrar, RoutingDescriptor } from "./types.js";
import { upsertJsonConfig, standardServerEntry } from "./json-config.js";
import { resolveBinary } from "../env/resolve-binary.js";

export class GeminiRegistrar implements AIToolRegistrar {
  name = "Gemini CLI";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".gemini");
  }

  async isInstalled(): Promise<boolean> {
    return (await resolveBinary("gemini")) !== null;
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

  // Gemini's lineup turns over faster than our release cadence, so the tiers
  // ship unnamed rather than pinned to a preview id that dies next quarter.
  routing: RoutingDescriptor = {
    hostKey: "gemini",
    mechanism: "agent-definition",
    howToApply:
      "set `model:` in the sub-agent's frontmatter under `~/.gemini/agents/` (user) or " +
      "`.gemini/agents/` (project). It defaults to `inherit`, so an agent that never names a " +
      "model silently runs at the session's tier.",
    labelField: null,
    models: DEFAULT_HOST_MODELS.gemini!,
  };

  async writtenRoutingVersion(): Promise<number | null> {
    return readWrittenRoutingVersion(join(this.baseDir, "GEMINI.md"));
  }

  async writeModelRouting(content: string): Promise<void> {
    await writeRoutingSection(join(this.baseDir, "GEMINI.md"), content);
  }
}
