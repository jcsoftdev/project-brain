import { join } from "node:path";
import { homedir } from "node:os";
import { writeSection } from "../rules/section-marker.js";
import type { AIToolRegistrar } from "./types.js";
import { resolveBinary } from "../env/resolve-binary.js";

export class CodexRegistrar implements AIToolRegistrar {
  name = "Codex";
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".codex");
  }

  async isInstalled(): Promise<boolean> {
    return (await resolveBinary("codex")) !== null;
  }

  async register(serverPath: string): Promise<void> {
    try {
      // Resolved path, not the bare name — see the note in claude.ts.
      const codexBin = (await resolveBinary("codex")) ?? "codex";
      const proc = Bun.spawn(
        [codexBin, "mcp", "add", "project-brain", "--", "bun", serverPath],
        { stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`[Codex] CLI registration failed: ${stderr.trim()}`);
      }
    } catch (e: any) {
      console.warn(`[Codex] CLI not available: ${e.message}`);
    }
  }

  async writeRules(rulesContent: string): Promise<void> {
    const rulesPath = join(this.baseDir, "instructions.md");
    await writeSection(rulesPath, rulesContent);
  }
}
