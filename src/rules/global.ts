import { join } from "node:path";
import { renderToolDocs } from "../constants.js";

const TEMPLATES_DIR = join(import.meta.dir, "../../templates");

const FALLBACK = `## project-brain MCP

You have access to the \`project-brain\` MCP server for codebase knowledge retrieval.

{{tools}}
`;

/**
 * Load global rules template for a given AI tool.
 * Falls back to generic content if no specific template exists.
 * The {{tools}} placeholder is filled from the single TOOL_CATALOG source in
 * constants.ts so the tool list never drifts from what the server registers.
 */
export async function getGlobalRules(tool: string): Promise<string> {
  const templatePath = join(TEMPLATES_DIR, `rules.${tool}.md`);

  let template: string;
  try {
    template = await Bun.file(templatePath).text();
  } catch {
    template = FALLBACK;
  }

  return template.replace(/\{\{tools\}\}/g, renderToolDocs());
}
