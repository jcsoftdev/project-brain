export interface EditTarget {
  filePath: string;
  sessionId: string;
  agentId: string;
}

export const MAIN_AGENT = "main";

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

export function parseEditTarget(payload: unknown): EditTarget | null {
  if (!isRecord(payload) || !nonEmpty(payload.tool_name) || !EDIT_TOOLS.has(payload.tool_name)) return null;
  if (!isRecord(payload.tool_input) || !nonEmpty(payload.tool_input.file_path)) return null;
  if (!nonEmpty(payload.session_id)) return null;
  return {
    filePath: payload.tool_input.file_path,
    sessionId: payload.session_id,
    agentId: nonEmpty(payload.agent_id) ? payload.agent_id : MAIN_AGENT,
  };
}
