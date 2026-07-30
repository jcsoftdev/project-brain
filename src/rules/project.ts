import { join } from "node:path";
import template from "../../templates/project.claude.md" with { type: "text" };
import { writeSection } from "./section-marker.js";
import { renderToolDocs } from "../constants.js";
import type { StackInfo } from "../indexer/stack.js";

export interface ProjectRulesInfo {
  projectId: string;
  stack: StackInfo;
  /** Optional list of detected module names to include in the Module Documentation section. */
  modules?: string[];
  /**
   * Whether an OKF knowledge bundle exists in this project.
   *
   * Gates the whole knowledge-bundle section. A project without a bundle must
   * not be told to maintain one — that instruction would be dead weight in
   * every CLAUDE.md project-brain touches. `project-brain init` runs before any
   * bundle exists, so `okf init` re-renders this file once it has created one.
   */
  hasOkfBundle?: boolean;
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
 * Render the knowledge-bundle section, but only when a bundle actually exists.
 *
 * The end-of-task checkpoint is deliberately a DECISION, not a writing task,
 * and "nothing to record" is stated as the common outcome. An instruction that
 * reads as "produce a concept per task" turns a curated bundle into a concept
 * mill, and noise in a knowledge bundle is worse than gaps: it destroys the
 * signal that made the bundle worth reading. Concepts are rare by nature —
 * tens over a project's life, against thousands of commits.
 */
function renderOkfSection(hasBundle: boolean): string {
  if (!hasBundle) return "";

  return `
## Knowledge bundle (\`okf/\`)

This project keeps an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) v0.2 bundle under \`okf/\` — the reasoning the code cannot hold: why a thing is built this way, which constraints must keep holding, and the traps that already cost someone a debugging session.

- Read it. \`search_context\` returns these concepts alongside the code they explain, so the *why* is already in reach.
- \`project-brain okf audit\` cross-checks the bundle against the code graph: broken anchors, stale concepts, coverage gaps, missing links. It exits 1 on broken and stale, so it works as a CI gate.
- The \`brain-okf\` skill knows the format, verifies anchors with \`find_symbol\`, and writes the file.

### At the end of a task, decide — do not write by default

When you finish a piece of work, ask once whether anything in it belongs in the bundle:

- A fix whose **cause was surprising** — the symptom pointed somewhere else.
- A decision where a **real alternative was rejected**, and the reason is not obvious from the result.
- A **constraint** that must keep holding, where violating it breaks something non-locally.

**Most tasks produce nothing, and that is the expected answer.** Say so and move on. Do not restate the diff — \`conceptualize\` already writes module docs from it on every commit. Do not mine \`okf audit\`'s coverage gaps for candidates: they rank by structural centrality, not by explanatory need, so the top of that list is usually accessors and formatters with no interesting why.

If there IS something, propose the type, title, and anchor, and let the human confirm before any file is created.
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
  const modulesSection = renderModulesSection(info.modules ?? []);

  const rendered = template
    .replace(/\{\{projectId\}\}/g, info.projectId)
    .replace(/\{\{stack\}\}/g, formatStack(info.stack))
    .replace(/\{\{tools\}\}/g, renderToolDocs())
    .replace(/\{\{modules\}\}/g, modulesSection)
    .replace(/\{\{okf\}\}/g, renderOkfSection(info.hasOkfBundle ?? false));

  const claudeMdPath = join(root, "CLAUDE.md");
  await writeSection(claudeMdPath, rendered);
}
