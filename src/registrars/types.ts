import type { HostRoutingModels } from "../constants.js";

/**
 * How a host lets a caller choose a sub-agent's model.
 *
 * `per-spawn` — the model is an argument of the delegation call itself.
 * `agent-definition` — the model lives in an agent file, fixed before any call.
 *
 * The distinction is the whole reason this descriptor exists: guidance written
 * for one mechanism is unfollowable on the other.
 */
export interface RoutingDescriptor {
  /** Key into the per-host model maps and the user config (e.g. "claude"). */
  hostKey: string;
  mechanism: "per-spawn" | "agent-definition";
  /** Host-specific sentence: exactly how to apply a tier here. */
  howToApply: string;
  /**
   * The user-visible field naming a RUNNING sub-agent, so the chosen model can
   * be prefixed into it. `null` where the host only names agent definitions —
   * a per-call prefix has nowhere to go, and the label rule is dropped.
   */
  labelField: string | null;
  /** Built-in tier→model defaults for this host; `null` where none is verifiable. */
  models: HostRoutingModels;
}

/** Strategy interface for registering project-brain in an AI tool. */
export interface AIToolRegistrar {
  /** Display name for CLI output (e.g. "Claude Code"). */
  name: string;

  /**
   * Present when this host can carry model-routing guidance. Its presence IS
   * the eligibility test — VS Code and Zed write no rules file, so they have
   * nowhere to put a section and leave this undefined.
   */
  routing?: RoutingDescriptor;

  /** Check if this AI tool is installed on the system. */
  isInstalled(): Promise<boolean>;

  /** Register project-brain MCP server in this tool's config. */
  register(serverPath: string): Promise<void>;

  /** Write global rules to this tool's instruction file. */
  writeRules(rulesContent: string): Promise<void>;

  /**
   * The content version of the model-routing section already written, or null
   * when there is none.
   *
   * Replaces the old boolean `hasModelRouting()`, which conflated "already
   * there" with "already current" — so an improved section never reached a
   * user who had accepted an earlier one.
   *
   * Required on any registrar that declares `routing`.
   */
  writtenRoutingVersion?(): Promise<number | null>;

  /** Write the model-routing section. Required on any registrar with `routing`. */
  writeModelRouting?(content: string): Promise<void>;
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
