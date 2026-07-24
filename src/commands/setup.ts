import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { detectEnvironment, type Environment } from "../env/detect.js";
import { getRegistrars, type AIToolRegistrar } from "../registrars/types.js";
import { UnparseableConfigError, standardServerEntry } from "../registrars/json-config.js";
import { getGlobalRules } from "../rules/global.js";
import { parseModelRoutingFlag } from "../cli-args.js";

export interface SetupOptions {
  dataDir?: string;
  skipOllama?: boolean;
  skipRegistration?: boolean;
  /** Injectable for testing; defaults to the real getRegistrars(). */
  registrars?: AIToolRegistrar[];
  /** Non-interactive override for the opt-in model-routing prompt. Defaults to "ask". */
  modelRouting?: "ask" | "yes" | "no";
  /** Injectable for testing; defaults to the real promptModelRouting from src/interactive.js. */
  promptModelRouting?: () => Promise<boolean>;
}

export interface SetupResult {
  dataDir: string;
  env: Environment;
  registeredTools: string[];
  /** Human-readable manual-setup instructions for registrars that could not
   *  safely auto-register (e.g. an unparseable config file). */
  manualInstructions: string[];
}

/** Tool names whose settings file is commonly hand-edited as JSONC (comments allowed). */
const JSONC_TOOLS = new Set(["Zed", "VS Code"]);

function buildManualInstructions(
  toolName: string,
  err: UnparseableConfigError
): string {
  const jsoncHint = JSONC_TOOLS.has(toolName)
    ? ` This file commonly contains JSONC comments — project-brain does not rewrite JSONC files to avoid stripping your comments.`
    : "";
  const snippet = JSON.stringify(
    standardServerEntry("<path-to-project-brain>"),
    null,
    2
  );
  return (
    `${toolName} config at ${err.configPath} is not valid JSON (JSONC/comments?)` +
    ` — add this entry manually:${jsoncHint}\n${snippet}`
  );
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
  const manualInstructions: string[] = [];

  if (!options.skipRegistration) {
    const registrars = options.registrars ?? (await getRegistrars());
    const serverPath =
      Bun.which("project-brain") ??
      join(import.meta.dir, "../../src/cli.ts");

    for (const registrar of registrars) {
      const installed = await registrar.isInstalled();
      if (!installed) continue;

      let registered = false;
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
        registered = true;
      } catch (e: any) {
        if (e instanceof UnparseableConfigError) {
          manualInstructions.push(buildManualInstructions(registrar.name, e));
        } else {
          console.warn(`Warning: Failed to register in ${registrar.name}: ${e.message}`);
        }
      }

      if (registered && registrar.hasModelRouting && registrar.writeModelRouting) {
        try {
          const mode = options.modelRouting ?? "ask";
          if (mode === "no") {
            // skip entirely
          } else if (mode === "yes") {
            const { getModelRoutingSection } = await import("../rules/model-routing.js");
            await registrar.writeModelRouting(await getModelRoutingSection());
          } else {
            const already = await registrar.hasModelRouting();
            if (!already) {
              const prompt =
                options.promptModelRouting ?? (await import("../interactive.js")).promptModelRouting;
              const accepted = await prompt();
              if (accepted) {
                const { getModelRoutingSection } = await import("../rules/model-routing.js");
                await registrar.writeModelRouting(await getModelRoutingSection());
              }
            }
          }
        } catch (e: any) {
          console.warn(`Warning: Failed to write model-routing guidance for ${registrar.name}: ${e.message}`);
        }
      }
    }
  }

  return { dataDir, env, registeredTools, manualInstructions };
}

/** CLI entry point for the setup command. */
export async function execute(args: string[]): Promise<void> {
  console.log("project-brain setup\n");

  const modelRouting = parseModelRoutingFlag(args);
  const result = await runSetup({ modelRouting });

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

  if (result.manualInstructions.length > 0) {
    console.log(`\nManual setup needed:`);
    for (const instructions of result.manualInstructions) {
      console.log(`\n${instructions}`);
    }
  }

  console.log("\nSetup complete. Run `project-brain init` in a project.");
}
