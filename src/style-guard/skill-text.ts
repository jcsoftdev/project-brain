import type { ShippedSkill } from "./rules.js";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const HTML_COMMENT = /<!--[\s\S]*?-->\s*/g;

export function skillBody(markdown: string): string {
  return markdown.replace(FRONTMATTER, "").replace(HTML_COMMENT, "").trim();
}

export function renderInjection(skills: ReadonlyArray<{ skill: ShippedSkill; body: string }>): string {
  return skills
    .map(({ skill, body }) => `project-brain style-guard: the ${skill} skill applies to this edit. Follow it.\n\n${body}`)
    .join("\n\n---\n\n");
}
