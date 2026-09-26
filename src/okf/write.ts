import { relative, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { BundleLayout } from "./anchors.js";

/**
 * Pure rendering helpers for `okf_write` (see `src/tools/okf-write.ts` for the
 * MCP-facing glue: argument validation, anchor resolution, and filesystem I/O).
 * Kept dependency-free of the graph/filesystem so the concept-file shape and
 * the index.md update rule are testable without a repo on disk.
 */

/** Same slugging rule as `manage_adr` (src/tools/adr.ts) — kept independent since the two write into different stores. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * English pluralization for an OKF `type` value, matching the bundle
 * convention of a singular Type living in a plural directory (`Gotcha` ->
 * `gotchas/`). The vocabulary is the bundle's own convention (SPEC v0.2 does
 * not constrain `type`), so this only needs to cover ordinary English nouns,
 * not an exhaustive irregular-plural table.
 */
export function pluralizeType(type: string): string {
  const lower = type.toLowerCase();
  if (/[sxz]$|[cs]h$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * Renders a repo-relative anchor as the bundle-relative `resource:` value a
 * concept file stores on disk — resolved from the BUNDLE ROOT, matching the
 * convention every existing concept in this codebase already uses (`../src/...`).
 */
export function computeBundleResource(repoRelPath: string, fragment: string | null, layout: BundleLayout): string {
  const rel = relative(layout.bundleRoot, `${layout.repoRoot}/${repoRelPath}`).split(sep).join("/");
  return fragment ? `${rel}#${fragment}` : rel;
}

export interface ConceptSource {
  resource: string;
  title?: string;
}

export interface RenderConceptInput {
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  resource: string;
  sources?: ConceptSource[];
  status?: "draft" | "stable" | "deprecated";
  generatedBy: string;
  generatedAt: string;
  /** Heading -> markdown body, in the order they should appear (e.g. Symptom, Why, Fix). */
  body: Record<string, string>;
}

/** Renders a full OKF v0.2 concept document: YAML frontmatter + heading sections. */
export function renderConcept(input: RenderConceptInput): string {
  const frontmatter: Record<string, unknown> = {
    type: input.type,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    resource: input.resource,
    ...(input.sources && input.sources.length > 0 ? { sources: input.sources } : {}),
    status: input.status ?? "stable",
    generated: { by: input.generatedBy, at: input.generatedAt },
  };

  const yaml = stringifyYaml(frontmatter).trimEnd();
  const body = Object.entries(input.body)
    .map(([heading, content]) => `# ${heading}\n\n${content.trim()}`)
    .join("\n\n");

  return `---\n${yaml}\n---\n\n${body}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Appends one bullet to a bundle `index.md`, the way the `brain-okf` skill
 * does by hand: under the `## <sectionHeading>` heading, right after the last
 * existing bullet in that section (or right after the heading, if the section
 * is new or still empty). Creates the section at the end of the file when it
 * does not exist yet — a bundle's first concept of a given type has nowhere
 * else to go.
 */
export function appendIndexEntry(indexMd: string, sectionHeading: string, bulletLine: string): string {
  const lines = indexMd.split("\n");
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(sectionHeading)}\\s*$`);
  const startIdx = lines.findIndex((l) => headingRe.test(l));

  if (startIdx === -1) {
    const trimmed = indexMd.replace(/\s+$/, "");
    return `${trimmed}\n\n## ${sectionHeading}\n${bulletLine}\n`;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }

  let lastBullet = -1;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (/^\*\s+/.test(lines[i]!)) lastBullet = i;
  }

  const insertAt = lastBullet !== -1 ? lastBullet + 1 : startIdx + 1;
  return [...lines.slice(0, insertAt), bulletLine, ...lines.slice(insertAt)].join("\n");
}
