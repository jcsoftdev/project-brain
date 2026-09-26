import claudeTemplate from "../../templates/rules.claude.md" with { type: "text" };
import codexTemplate from "../../templates/rules.codex.md" with { type: "text" };
import geminiTemplate from "../../templates/rules.gemini.md" with { type: "text" };
import { renderToolDocs } from "../constants.js";
import { extractSection } from "../markers.js";

const FALLBACK = `## project-brain MCP

You have access to the \`project-brain\` MCP server for codebase knowledge retrieval.

{{tools}}
`;

// Templates are embedded at build time (`with { type: "text" }`), not read
// from disk at runtime — `import.meta.dir`-relative reads break under
// `bun build --compile`, where the compiled binary has no real filesystem
// path back to a sibling `templates/` directory. Tools without a dedicated
// template (cursor, windsurf, zed, vscode, ...) fall through to FALLBACK,
// same as before.
const TEMPLATES: Record<string, string> = {
  claude: claudeTemplate,
  codex: codexTemplate,
  gemini: geminiTemplate,
};

/**
 * Load global rules template for a given AI tool.
 * Falls back to generic content if no specific template exists.
 * The {{tools}} placeholder is filled from the single TOOL_CATALOG source in
 * constants.ts so the tool list never drifts from what the server registers.
 */
export async function getGlobalRules(tool: string): Promise<string> {
  const template = TEMPLATES[tool] ?? FALLBACK;
  return template.replace(/\{\{tools\}\}/g, renderToolDocs());
}

/**
 * Whether the project-brain section already written at `rulesPath` matches
 * what `getGlobalRules(tool)` would render today.
 *
 * `inspect()` used to only ask the MCP config "are we registered" and never
 * looked at the rules file at all, so a block written by an older release
 * (or an older template) stayed "current" forever — `apply()` never had a
 * reason to touch it again. This is the missing half: a byte-for-byte
 * comparison of the managed section, so a stale block is reported and healed
 * through the normal setup path instead of a manual edit.
 */
export async function isGlobalRulesCurrent(rulesPath: string, tool: string): Promise<boolean> {
  let text: string;
  try {
    text = await Bun.file(rulesPath).text();
  } catch {
    return false;
  }
  return extractSection(text) === (await getGlobalRules(tool));
}
