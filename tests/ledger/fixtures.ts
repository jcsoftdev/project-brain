/** Synthetic transcript lines in the shapes Claude Code writes them. No real session content. */

let n = 0;
const base = { isSidechain: false, userType: "external", version: "2.1.0", gitBranch: "main" };

export interface LineOpts {
  sessionId: string;
  cwd: string;
  at: string;
  agentId?: string;
}

const envelope = (o: LineOpts, type: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    parentUuid: null,
    ...base,
    ...(o.agentId ? { agentId: o.agentId, isSidechain: true } : {}),
    type,
    uuid: `u-${++n}`,
    timestamp: o.at,
    cwd: o.cwd,
    sessionId: o.sessionId,
    ...extra,
  });

export const userPrompt = (o: LineOpts, text: string) => envelope(o, "user", { message: { role: "user", content: text } });

export function injection(o: LineOpts, hits: Array<{ source: string; symbol?: string; lines?: [number, number]; score: number }>): string {
  const block = [
    "<project-brain: relevant context for this prompt>",
    ...hits.flatMap((h) => [
      `- ${h.source}${h.symbol ? ` › ${h.symbol}` : ""}${h.lines ? ` (L${h.lines[0]}-${h.lines[1]})` : ""} [score ${h.score.toFixed(2)}]`,
      "  first snippet line",
      "  second snippet line",
    ]),
    "</project-brain>",
  ].join("\n");
  return envelope(o, "attachment", {
    attachment: {
      type: "hook_success",
      hookName: "UserPromptSubmit",
      toolUseID: `t-${n}`,
      hookEvent: "UserPromptSubmit",
      content: block,
      stdout: block,
      stderr: "",
      exitCode: 0,
      command: "project-brain: injecting context",
      durationMs: 120,
    },
  });
}

export const toolUse = (o: LineOpts, name: string, input: Record<string, unknown>, id = `toolu_${++n}`) =>
  envelope(o, "assistant", { message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });

export const toolResult = (o: LineOpts, id: string, content: unknown) =>
  envelope(o, "user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

export const toolsDelta = (o: LineOpts, added: string[], removed: string[] = []) =>
  envelope(o, "attachment", {
    attachment: { type: "deferred_tools_delta", addedNames: added, addedLines: added, removedNames: removed, wireHiddenNames: [], readdedNames: [], pendingMcpServers: [], failedMcpServers: [] },
  });

export const instructionsDelta = (o: LineOpts, blocks: Record<string, string>) =>
  envelope(o, "attachment", {
    attachment: { type: "mcp_instructions_delta", addedNames: Object.keys(blocks), addedBlocks: Object.values(blocks), removedNames: [] },
  });

export const instructionsRemoved = (o: LineOpts, names: string[]) =>
  envelope(o, "attachment", { attachment: { type: "mcp_instructions_delta", addedNames: [], removedNames: names } });

export const compactBoundary = (o: LineOpts) =>
  envelope(o, "system", { subtype: "compact_boundary", content: "Conversation compacted", level: "info", compactMetadata: { trigger: "auto" } });

export const transcript = (lines: string[]): string => `${lines.join("\n")}\n`;
