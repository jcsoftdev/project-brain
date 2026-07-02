import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { handleIngest } from "./ingest.js";

export interface AdrArgs {
  project: string;
  action: "create" | "list";
  title?: string; context?: string; decision?: string; consequences?: string;
  status?: "proposed" | "accepted" | "superseded";
  supersedes?: string;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function render(a: Required<Pick<AdrArgs, "title" | "context" | "decision" | "consequences">> & { status: string; supersedes?: string }): string {
  return [
    `# ADR: ${a.title}`, "", `Status: ${a.status}`,
    ...(a.supersedes ? [`Supersedes: ${a.supersedes}`] : []), "",
    "## Context", a.context, "", "## Decision", a.decision, "", "## Consequences", a.consequences, "",
  ].join("\n");
}

export async function handleAdr(args: AdrArgs, deps: ToolDeps): Promise<ToolResult> {
  if (args.action === "list") {
    const chunks = await deps.store.getModuleChunks(args.project, "adr");
    const adrs = chunks.map((c) => ({
      slug: c.source.replace(/^adr\//, ""),
      title: (c.content.match(/^# ADR: (.+)$/m)?.[1] ?? c.source),
      status: (c.content.match(/^Status: (.+)$/m)?.[1] ?? "unknown"),
      updated_at: c.updated_at,
    }));
    return jsonResult({ adrs });
  }
  const { title, context, decision, consequences } = args;
  if (!title || !context || !decision || !consequences) {
    return jsonResult({ error: "create requires title, context, decision, consequences", code: "ADR_MISSING_FIELDS" }, true);
  }
  const slug = slugify(title);
  if (!slug) {
    return jsonResult({ error: "title must contain at least one alphanumeric character", code: "ADR_INVALID_TITLE" }, true);
  }
  const content = render({ title, context, decision, consequences, status: args.status ?? "proposed", supersedes: args.supersedes });
  const ingest = await handleIngest({ project: args.project, content, source: `adr/${slug}`, module: "adr" }, deps);
  if (ingest.isError) return ingest;
  return jsonResult({ slug, source: `adr/${slug}`, status: args.status ?? "proposed" });
}

/** Register manage_adr tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "manage_adr",
    {
      description: "Create or list Architecture Decision Records. Append-only: supersede by creating a new ADR with supersedes:<slug>.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        action: z.enum(["create", "list"]).describe("Action to perform"),
        title: z.string().optional().describe("ADR title (required for create)"),
        context: z.string().optional().describe("Context section (required for create)"),
        decision: z.string().optional().describe("Decision section (required for create)"),
        consequences: z.string().optional().describe("Consequences section (required for create)"),
        status: z.enum(["proposed", "accepted", "superseded"]).optional().describe("ADR status"),
        supersedes: z.string().optional().describe("Slug of ADR this supersedes"),
      },
      outputSchema: {
        slug: z.string().optional(),
        source: z.string().optional(),
        status: z.string().optional(),
        adrs: z.array(z.object({
          slug: z.string(),
          title: z.string(),
          status: z.string(),
          updated_at: z.number(),
        })).optional(),
        error: z.string().optional(),
        code: z.string().optional(),
      },
      annotations: toolAnnotations("manage_adr") ?? { idempotentHint: true, openWorldHint: false },
    },
    async (args) => handleAdr(args as AdrArgs, deps)
  );
}
