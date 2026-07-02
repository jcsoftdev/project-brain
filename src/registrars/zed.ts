import { join } from "node:path";
import { homedir } from "node:os";
import type { AIToolRegistrar } from "./types.js";
import { dirExists, upsertJsonConfig, standardServerEntry } from "./json-config.js";

/**
 * Doc-verified 2026-07 against zed.dev/docs/ai/mcp: custom context servers use
 * a FLAT `{ command, args, env }` shape, not the nested `command: { path, args }`
 * shape some older third-party guides describe. `standardServerEntry` already
 * matches this shape.
 */
export class ZedRegistrar implements AIToolRegistrar {
  name = "Zed";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".config", "zed");
  }

  async isInstalled(): Promise<boolean> {
    return dirExists(this.baseDir);
  }

  async register(serverPath: string): Promise<void> {
    // settings.json is the user's MAIN Zed settings file — upsertJsonConfig's
    // merge semantics (Task 12) are exactly what makes it safe to touch here.
    await upsertJsonConfig(join(this.baseDir, "settings.json"), (config) => {
      config.context_servers ??= {};
      config.context_servers["project-brain"] = standardServerEntry(serverPath);
    });
  }

  async writeRules(_rulesContent: string): Promise<void> {
    // Zed has no equivalent rules/instructions directory — no-op.
  }
}
