import { join } from "node:path";
import { renderModelRoutingTable } from "../constants.js";

const TEMPLATES_DIR = join(import.meta.dir, "../../templates");

/**
 * Load the Claude-only model-routing guidance section, with the
 * {{modelRoutingTable}} placeholder filled from the single MODEL_ROUTING
 * source in constants.ts.
 */
export async function getModelRoutingSection(): Promise<string> {
  const templatePath = join(TEMPLATES_DIR, "model-routing.claude.md");
  const template = await Bun.file(templatePath).text();
  return template.replace(/\{\{modelRoutingTable\}\}/g, renderModelRoutingTable());
}
