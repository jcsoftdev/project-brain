import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_HOST } from "../constants.js";

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

  // Cursor — detected via directory existence
  const cursorDir = join(home, ".cursor");
  let cursorInstalled = false;
  try {
    const stat = await Bun.file(join(cursorDir, "mcp.json")).exists();
    // If the directory has config or just exists
    cursorInstalled =
      stat || (await Bun.file(cursorDir).exists().catch(() => false)) || false;
  } catch {
    // Try directory existence via a different approach
    try {
      const proc = Bun.spawn(["test", "-d", cursorDir], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      cursorInstalled = code === 0;
    } catch {
      cursorInstalled = false;
    }
  }

  tools.push({
    name: "Cursor",
    binaryPath: null,
    configPath: join(cursorDir, "mcp.json"),
    installed: cursorInstalled,
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
