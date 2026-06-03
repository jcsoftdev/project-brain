import { join } from "node:path";
import { writeSection } from "./section-marker.js";
import type { StackInfo } from "../indexer/stack.js";

const TEMPLATES_DIR = join(import.meta.dir, "../../templates");

const FALLBACK_TEMPLATE = `# Project: {{projectId}}

This project is indexed with project-brain.

## project-brain MCP

Use the project-brain MCP tools (search_context, add_knowledge, list_modules, get_module, delete_knowledge, check_health) for codebase knowledge retrieval.

### Project Context

- **Project ID**: {{projectId}}
- **Stack**: {{stack}}
{{modules}}`;

export interface ProjectRulesInfo {
  projectId: string;
  stack: StackInfo;
  /** Optional list of detected module names to include in the Module Documentation section. */
  modules?: string[];
}

/**
 * Format a StackInfo into a human-readable string for template substitution.
 */
function formatStack(stack: StackInfo): string {
  const parts: string[] = [];

  if (stack.languages.length > 0) {
    parts.push(stack.languages.join(", "));
  }

  if (stack.frameworks.length > 0) {
    parts.push(`frameworks: ${stack.frameworks.join(", ")}`);
  }

  if (stack.packageManager) {
    parts.push(`package manager: ${stack.packageManager}`);
  }

  return parts.length > 0 ? parts.join(" — ") : "not detected";
}

/**
 * Render the Module Documentation section if modules are present.
 * Returns an empty string when the list is empty.
 */
function renderModulesSection(modules: string[]): string {
  if (modules.length === 0) return "";

  const moduleList = modules.map((m) => `- ${m}`).join("\n");

  return `\n## Module Documentation

Detected modules:
${moduleList}

For each module stub in docs/modules/:
1. Read the stub file.
2. Fill in each section (Purpose, Key Files, Dependencies, Data Flow, Gotchas, Last Updated).
3. Call add_knowledge with the filled content, source: "docs/modules/<name>.md",
   tags: ["module", "<name>"].
Do this automatically when you open a project session and a stub is unfilled.
`;
}

/**
 * Write project-specific rules into <root>/CLAUDE.md using the project template.
 * Substitutes {{projectId}} and {{stack}} placeholders.
 * Uses writeSection for idempotent marker-based insertion.
 */
export async function writeProjectRules(
  root: string,
  info: ProjectRulesInfo
): Promise<void> {
  const templatePath = join(TEMPLATES_DIR, "project.claude.md");

  let template: string;
  try {
    template = await Bun.file(templatePath).text();
  } catch {
    template = FALLBACK_TEMPLATE;
  }

  const modulesSection = renderModulesSection(info.modules ?? []);

  const rendered = template
    .replace(/\{\{projectId\}\}/g, info.projectId)
    .replace(/\{\{stack\}\}/g, formatStack(info.stack))
    .replace(/\{\{modules\}\}/g, modulesSection);

  const claudeMdPath = join(root, "CLAUDE.md");
  await writeSection(claudeMdPath, rendered);
}
