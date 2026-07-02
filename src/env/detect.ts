import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_HOST } from "../constants.js";
import { dirExists } from "../registrars/json-config.js";
import { defaultVSCodeUserDir } from "../registrars/vscode.js";

export interface AIToolInfo {
  name: string;
  binaryPath: string | null;
  configPath: string;
  installed: boolean;
}

export interface OllamaInfo {
  available: boolean;
  host: string;
  models: string[];
}

export interface Environment {
  bun: string;
  platform: NodeJS.Platform;
  arch: string;
  ollama: OllamaInfo;
  aiTools: AIToolInfo[];
}

async function detectOllama(): Promise<OllamaInfo> {
  const host = OLLAMA_HOST;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${host}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { available: false, host, models: [] };
    }

    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    return { available: true, host, models };
  } catch {
    return { available: false, host, models: [] };
  }
}

async function detectAITools(): Promise<AIToolInfo[]> {
  const home = homedir();
  const tools: AIToolInfo[] = [];

  // Claude Code
  const claudePath = Bun.which("claude");
  tools.push({
    name: "Claude Code",
    binaryPath: claudePath,
    configPath: join(home, ".claude", "CLAUDE.md"),
    installed: claudePath !== null,
  });

  // Codex
  const codexPath = Bun.which("codex");
  tools.push({
    name: "Codex",
    binaryPath: codexPath,
    configPath: join(home, ".codex", "instructions.md"),
    installed: codexPath !== null,
  });

  // Gemini CLI
  const geminiPath = Bun.which("gemini");
  tools.push({
    name: "Gemini CLI",
    binaryPath: geminiPath,
    configPath: join(home, ".gemini", "settings.json"),
    installed: geminiPath !== null,
  });

  // Cursor — detected via directory existence (Windows-safe: no `test` spawn)
  const cursorDir = join(home, ".cursor");
  tools.push({
    name: "Cursor",
    binaryPath: null,
    configPath: join(cursorDir, "mcp.json"),
    installed: await dirExists(cursorDir),
  });

  // Windsurf — detected via directory existence
  const windsurfDir = join(home, ".codeium", "windsurf");
  tools.push({
    name: "Windsurf",
    binaryPath: null,
    configPath: join(windsurfDir, "mcp_config.json"),
    installed: await dirExists(windsurfDir),
  });

  // Zed — detected via directory existence
  const zedDir = join(home, ".config", "zed");
  tools.push({
    name: "Zed",
    binaryPath: null,
    configPath: join(zedDir, "settings.json"),
    installed: await dirExists(zedDir),
  });

  // VS Code — detected via directory existence (platform-specific user dir)
  const vscodeDir = defaultVSCodeUserDir();
  tools.push({
    name: "VS Code",
    binaryPath: null,
    configPath: join(vscodeDir, "mcp.json"),
    installed: await dirExists(vscodeDir),
  });

  return tools;
}

/** Detect the full runtime environment. */
export async function detectEnvironment(): Promise<Environment> {
  const [ollama, aiTools] = await Promise.all([
    detectOllama(),
    detectAITools(),
  ]);

  return {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    ollama,
    aiTools,
  };
}
