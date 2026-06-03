import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { detectEnvironment, type Environment } from "../env/detect.js";
import { getRegistrars } from "../registrars/types.js";
import { getGlobalRules } from "../rules/global.js";

export interface SetupOptions {
  dataDir?: string;
  skipOllama?: boolean;
  skipRegistration?: boolean;
}

export interface SetupResult {
  dataDir: string;
  env: Environment;
  registeredTools: string[];
}

const DEFAULT_DATA_DIR = join(homedir(), ".project-brain");

/**
 * Core setup logic — testable with injectable options.
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;

  // 1. Create data directory
  await mkdir(dataDir, { recursive: true });

  // 2. Detect environment
  const env = await detectEnvironment();

  // 3. Pull Ollama model if available (and not skipped)
  if (!options.skipOllama && env.ollama.available) {
    if (!env.ollama.models.includes("nomic-embed-text")) {
      try {
        const proc = Bun.spawn(["ollama", "pull", "nomic-embed-text"], {
          stdout: "inherit",
          stderr: "inherit",
        });
        await proc.exited;
      } catch {
        console.warn("Warning: Failed to pull Ollama model.");
      }
    }
  } else if (!options.skipOllama && !env.ollama.available) {
    console.warn(
      "Warning: Ollama not available. Embedding features will be degraded."
    );
  }

  // 4. Register in AI tools
  const registeredTools: string[] = [];

  if (!options.skipRegistration) {
    const registrars = await getRegistrars();
    const serverPath =
      Bun.which("project-brain") ??
      join(import.meta.dir, "../../src/cli.ts");

    for (const registrar of registrars) {
      const installed = await registrar.isInstalled();
      if (!installed) continue;

      try {
        await registrar.register(serverPath);

        // Determine tool key for template loading
        const toolKey = registrar.name
          .toLowerCase()
          .replace(/\s+/g, "")
          .replace("claudecode", "claude")
          .replace("geminicli", "gemini");
        const rules = await getGlobalRules(toolKey);
        await registrar.writeRules(rules);

        registeredTools.push(registrar.name);
      } catch (e: any) {
        console.warn(`Warning: Failed to register in ${registrar.name}: ${e.message}`);
      }
    }
  }

  return { dataDir, env, registeredTools };
}

/** CLI entry point for the setup command. */
export async function execute(_args: string[]): Promise<void> {
  console.log("project-brain setup\n");

  const result = await runSetup();

  console.log(`Environment:`);
  console.log(`  Bun: ${result.env.bun}`);
  console.log(`  Platform: ${result.env.platform} (${result.env.arch})`);
  console.log(
    `  Ollama: ${result.env.ollama.available ? "available" : "not found"}`
  );
  console.log(`  Data dir: ${result.dataDir}`);

  console.log(`\nAI Tools:`);
  for (const tool of result.env.aiTools) {
    const status = tool.installed ? "✓" : "✗";
    console.log(`  ${status} ${tool.name}`);
  }

  if (result.registeredTools.length > 0) {
    console.log(`\nRegistered in: ${result.registeredTools.join(", ")}`);
  }

  console.log("\nSetup complete. Run `project-brain init` in a project.");
}
