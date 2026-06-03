import { join } from "node:path";

const TEMPLATES_DIR = join(import.meta.dir, "../../templates");

const FALLBACK = `## project-brain MCP

Use the project-brain MCP tools (search_context, add_knowledge, list_modules, get_module, delete_knowledge, check_health) for codebase knowledge retrieval.

Use \`search_context\` for semantic/conceptual or cross-file questions (when you don't know the exact symbol); for exact symbol/caller lookups prefer a structural/AST tool or grep. After \`search_context\`, use \`expand_context(chunk_id)\` to read full bodies instead of re-reading whole files.
`;

/**
 * Load global rules template for a given AI tool.
 * Falls back to generic content if no specific template exists.
 */
export async function getGlobalRules(tool: string): Promise<string> {
  const templatePath = join(TEMPLATES_DIR, `rules.${tool}.md`);

  try {
    return await Bun.file(templatePath).text();
  } catch {
    return FALLBACK;
  }
}
