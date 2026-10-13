import { createHash } from "node:crypto";
import { DATA_DIR } from "../constants.js";
import { rankSemantic, type RankSpec, type SharedQuery } from "../skills/semantic.js";
import type { ToolEntry } from "./live.js";

const text = (tool: ToolEntry): string => `${tool.name}: ${tool.description}`.slice(0, 600);

/** The description is part of the key, so an edited tool is re-embedded while an unchanged one never is. */
const key = (tool: ToolEntry): string => `${tool.name}|${createHash("sha1").update(tool.description).digest("hex").slice(0, 8)}`;

/** Tool vectors live apart from skill vectors: different size, different churn. */
export const TOOL_SPEC: RankSpec<ToolEntry> = { filePrefix: "tool-vectors", text, key };

export function rankToolsSemantic(
  tools: ToolEntry[],
  query: SharedQuery,
  topN: number,
  cacheDir: string = DATA_DIR
): Promise<ToolEntry[] | null> {
  return rankSemantic(tools, TOOL_SPEC, query, topN, cacheDir);
}
