/** Strategy interface for registering project-brain in an AI tool. */
export interface AIToolRegistrar {
  /** Display name for CLI output (e.g. "Claude Code"). */
  name: string;

  /** Check if this AI tool is installed on the system. */
  isInstalled(): Promise<boolean>;

  /** Register project-brain MCP server in this tool's config. */
  register(serverPath: string): Promise<void>;

  /** Write global rules to this tool's instruction file. */
  writeRules(rulesContent: string): Promise<void>;
}

/** Returns all known registrar implementations. */
export async function getRegistrars(): Promise<AIToolRegistrar[]> {
  const { ClaudeRegistrar } = await import("./claude.js");
  const { CodexRegistrar } = await import("./codex.js");
  const { GeminiRegistrar } = await import("./gemini.js");
  const { CursorRegistrar } = await import("./cursor.js");
  const { WindsurfRegistrar } = await import("./windsurf.js");
  const { ZedRegistrar } = await import("./zed.js");
  const { VSCodeRegistrar } = await import("./vscode.js");
  const { OpencodeRegistrar } = await import("./opencode.js");

  return [
    new ClaudeRegistrar(),
    new CodexRegistrar(),
    new GeminiRegistrar(),
    new CursorRegistrar(),
    new WindsurfRegistrar(),
    new ZedRegistrar(),
    new VSCodeRegistrar(),
    new OpencodeRegistrar(),
  ];
}
