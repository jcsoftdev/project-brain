import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { parseResource, type AnchorResolutionResult } from "../okf/anchors.js";
import { readSymbols } from "../okf/audit.js";
import { DEFAULT_OKF_DIR } from "../okf/route.js";
import { appendIndexEntry, computeBundleResource, pluralizeType, renderConcept, slugifyTitle } from "../okf/write.js";

export interface OkfWriteSource {
  resource: string;
  title?: string;
}

export interface OkfWriteArgs {
  /** Must match the server's own project id, if given. */
  project?: string;
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  /** Repo-relative anchor: "src/x.ts", "src/x.ts#symbol", or "src/x.ts#L10-L20". */
  resource: string;
  sources?: OkfWriteSource[];
  /** Heading -> markdown content, in the order they should appear (e.g. Symptom, Why, Fix). */
  body: Record<string, string>;
  status?: "draft" | "stable" | "deprecated";
  /** Bundle directory, relative to the project root. Defaults to okf. */
  dir?: string;
}

function fragmentOf(resolution: AnchorResolutionResult): string | null {
  if (resolution.symbol !== null) return resolution.symbol;
  if (resolution.lines !== null) return `L${resolution.lines.start}-L${resolution.lines.end}`;
  return null;
}

interface RepoRelativeResolverDeps {
  exists(repoRelPath: string): boolean;
  hasSymbol(repoRelPath: string, symbol: string): boolean;
}

/**
 * Resolves an okf_write `resource`/`sources[].resource` argument, which is
 * REPO-relative ("src/x.ts#symbol") for tool ergonomics — unlike an on-disk
 * concept's `resource:` frontmatter, which is bundle-relative ("../src/x.ts").
 * Reuses `parseResource` (the same fragment grammar `okf audit`'s anchors use)
 * but skips `toRepoPath`'s bundle-root translation, since there is none to
 * undo here. `computeBundleResource` does the opposite conversion once this
 * resolves, for what actually gets written to disk.
 */
function resolveRepoRelativeAnchor(resource: string, deps: RepoRelativeResolverDeps): AnchorResolutionResult {
  const parsed = parseResource(resource);
  if (!parsed) return { ok: false, path: null, symbol: null, lines: null, reason: "unparseable" };

  const path = parsed.path;
  if (!deps.exists(path)) {
    return { ok: false, path, symbol: parsed.symbol, lines: parsed.lines, reason: "missing-file" };
  }
  if (parsed.symbol !== null && !deps.hasSymbol(path, parsed.symbol)) {
    return { ok: false, path, symbol: parsed.symbol, lines: null, reason: "missing-symbol" };
  }
  return { ok: true, path, symbol: parsed.symbol, lines: parsed.lines };
}

/**
 * `okf_write` — writes one Open Knowledge Format concept file, the way the
 * `brain-okf` skill does by hand: propose, verify every anchor, write, then
 * append the bundle's `index.md` entry.
 *
 * REFUSES and writes nothing when the primary anchor or any source anchor
 * does not resolve against the symbol graph — an unresolved anchor here would
 * become a "broken anchor" finding the moment anyone runs `okf audit`, so this
 * tool never produces one in the first place.
 */
export async function handleOkfWrite(args: OkfWriteArgs, deps: ToolDeps): Promise<ToolResult> {
  if (args.project && deps.projectId && args.project !== deps.projectId) {
    return jsonResult(
      {
        error: `okf_write only supports the server's own project ("${deps.projectId}"); got "${args.project}"`,
        code: "PROJECT_MISMATCH",
      },
      true
    );
  }
  if (!args.type?.trim() || !args.title?.trim() || !args.resource?.trim() || !args.body || Object.keys(args.body).length === 0) {
    return jsonResult(
      { error: "okf_write requires type, title, resource, and at least one body section", code: "MISSING_FIELDS" },
      true
    );
  }
  if (!deps.graph) return graphUnavailable();
  if (!deps.projectRoot) {
    return jsonResult({ error: "project root unavailable", code: "PROJECT_ROOT_UNAVAILABLE" }, true);
  }

  const projectRoot = deps.projectRoot;
  const bundleDir = join(projectRoot, args.dir ?? DEFAULT_OKF_DIR);
  const layout = { bundleRoot: bundleDir, repoRoot: projectRoot };
  const symbols = readSymbols(deps.graph);
  const resolverDeps = {
    exists: (repoRelPath: string) => existsSync(join(projectRoot, repoRelPath)),
    hasSymbol: (repoRelPath: string, symbol: string) =>
      (symbols.byFile.get(repoRelPath) ?? []).some((s) => s.name === symbol),
  };

  const primary = resolveRepoRelativeAnchor(args.resource, resolverDeps);
  const sourceResolutions = (args.sources ?? []).map((s) => ({ source: s, resolution: resolveRepoRelativeAnchor(s.resource, resolverDeps) }));

  const unresolved = [
    ...(primary.ok ? [] : [{ resource: args.resource, reason: primary.reason }]),
    ...sourceResolutions.filter((r) => !r.resolution.ok).map((r) => ({ resource: r.source.resource, reason: r.resolution.reason })),
  ];
  if (unresolved.length > 0) {
    return jsonResult(
      {
        error: `okf_write refuses: ${unresolved.length} anchor(s) do not resolve against the symbol graph — nothing was written`,
        code: "ANCHOR_UNRESOLVED",
        unresolved,
      },
      true
    );
  }

  const slug = slugifyTitle(args.title);
  if (!slug) {
    return jsonResult({ error: "title must contain at least one alphanumeric character", code: "INVALID_TITLE" }, true);
  }
  const typeDir = pluralizeType(args.type);
  const bundleRelPath = `${typeDir}/${slug}.md`;
  const filePath = join(bundleDir, bundleRelPath);
  if (existsSync(filePath)) {
    return jsonResult({ error: `${bundleRelPath} already exists — okf_write never overwrites`, code: "ALREADY_EXISTS" }, true);
  }

  const resource = computeBundleResource(primary.path!, fragmentOf(primary), layout);
  const sources = sourceResolutions.map(({ source, resolution }) => ({
    resource: computeBundleResource(resolution.path!, fragmentOf(resolution), layout),
    ...(source.title ? { title: source.title } : {}),
  }));

  const content = renderConcept({
    type: args.type,
    title: args.title,
    description: args.description,
    tags: args.tags,
    resource,
    sources,
    status: args.status,
    generatedBy: "project-brain/mcp",
    generatedAt: new Date().toISOString(),
    body: args.body,
  });

  await mkdir(join(bundleDir, typeDir), { recursive: true });
  await writeFile(filePath, content, "utf-8");

  let indexUpdated = false;
  const indexPath = join(bundleDir, "index.md");
  if (existsSync(indexPath)) {
    const sectionHeading = typeDir.charAt(0).toUpperCase() + typeDir.slice(1);
    const bulletLine = args.description
      ? `* [${args.title}](/${bundleRelPath}) - ${args.description}`
      : `* [${args.title}](/${bundleRelPath})`;
    const existingIndex = await readFile(indexPath, "utf-8");
    await writeFile(indexPath, appendIndexEntry(existingIndex, sectionHeading, bulletLine), "utf-8");
    indexUpdated = true;
  }

  return jsonResult({
    path: bundleRelPath,
    type: args.type,
    title: args.title,
    resource,
    anchors: [
      { resource, path: primary.path, symbol: primary.symbol },
      ...sources.map((s, i) => ({ resource: s.resource, path: sourceResolutions[i]!.resolution.path, symbol: sourceResolutions[i]!.resolution.symbol })),
    ],
    indexUpdated,
  });
}

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "okf_write",
    {
      description:
        "Write one Open Knowledge Format concept file into this project's knowledge bundle (default ./okf). " +
        "Validates EVERY anchor (the primary `resource` and every `sources[]` entry) against the symbol graph and " +
        "REFUSES, writing nothing, when any of them does not resolve. Never overwrites an existing concept file. " +
        "Appends the new concept's entry to okf/index.md, the way the brain-okf skill does by hand.",
      inputSchema: {
        project: z.string().optional().describe("Must match the server's own project id, if given."),
        type: z.string().describe('Concept type, e.g. "Gotcha", "Decision", "Constraint" — determines the bundle subdirectory.'),
        title: z.string().describe("Concept title — also becomes the filename slug."),
        description: z.string().optional().describe("One line — shown in index.md and search results."),
        tags: z.array(z.string()).optional(),
        resource: z.string().describe('Primary anchor: "src/x.ts", "src/x.ts#symbol", or "src/x.ts#L10-L20", repo-relative.'),
        sources: z
          .array(z.object({ resource: z.string(), title: z.string().optional() }))
          .optional()
          .describe("Additional anchors, each validated the same way as `resource`."),
        body: z.record(z.string(), z.string()).describe('Heading -> markdown content, e.g. { "Symptom": "...", "Why": "...", "Fix": "..." }.'),
        status: z.enum(["draft", "stable", "deprecated"]).optional(),
        dir: z.string().optional().describe("Bundle directory, relative to the project root. Defaults to okf."),
      },
      outputSchema: {
        path: z.string().optional(),
        type: z.string().optional(),
        title: z.string().optional(),
        resource: z.string().optional(),
        anchors: z.array(z.object({ resource: z.string(), path: z.string().nullable(), symbol: z.string().nullable() })).optional(),
        indexUpdated: z.boolean().optional(),
        error: z.string().optional(),
        code: z.string().optional(),
        unresolved: z.array(z.object({ resource: z.string(), reason: z.string().optional() })).optional(),
      },
      annotations: toolAnnotations("okf_write") ?? { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => handleOkfWrite(args as OkfWriteArgs, deps)
  );
}
