import template from "../../templates/model-routing.claude.md" with { type: "text" };
import { renderModelRoutingTable } from "../constants.js";

/**
 * Load the Claude-only model-routing guidance section, with the
 * {{modelRoutingTable}} placeholder filled from the single MODEL_ROUTING
 * source in constants.ts.
 *
 * The template is embedded at build time (`with { type: "text" }`), not read
 * from disk at runtime — `import.meta.dir`-relative reads break under
 * `bun build --compile`, where the compiled binary has no real filesystem
 * path back to a sibling `templates/` directory.
 */
export async function getModelRoutingSection(): Promise<string> {
  return template.replace(/\{\{modelRoutingTable\}\}/g, renderModelRoutingTable());
}
