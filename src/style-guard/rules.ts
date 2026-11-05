import { extname } from "node:path";

export type ShippedSkill = "brain-style";

export interface SkillRule {
  skill: ShippedSkill;
  extensions: ReadonlySet<string>;
  summary: string;
}

export type PathVerdict = { kind: "apply"; skills: ShippedSkill[] } | { kind: "skip" } | { kind: "unknown" };

const extensionSet = (extensions: string[]): ReadonlySet<string> => new Set(extensions);

export const SKILL_RULES: readonly SkillRule[] = [
  {
    skill: "brain-style",
    summary: "how to write or edit source code: architecture first, typed contracts, no duplication, zero comments",
    extensions: extensionSet([
      ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
      ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".rb", ".php", ".cs",
      ".c", ".h", ".cc", ".cpp", ".hpp", ".dart", ".lua", ".ex", ".exs", ".sql", ".sh", ".bash", ".zsh",
    ]),
  },
];

export const NON_CODE_EXTENSIONS: ReadonlySet<string> = extensionSet([
  ".md", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".lock", ".csv", ".log",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".ini", ".map",
]);

export function classifyPath(filePath: string): PathVerdict {
  const extension = extname(filePath).toLowerCase();
  const skills = SKILL_RULES.filter((rule) => rule.extensions.has(extension)).map((rule) => rule.skill);
  if (skills.length > 0) return { kind: "apply", skills };
  return NON_CODE_EXTENSIONS.has(extension) ? { kind: "skip" } : { kind: "unknown" };
}
