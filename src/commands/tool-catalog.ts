import { refreshCatalog } from "../toolcatalog/catalog.js";

/** `project-brain tool-catalog refresh` — rebuilds the MCP tool catalog the prompt hook reads. */
export async function execute(args: string[]): Promise<void> {
  if (args[0] !== "refresh") {
    console.error("usage: project-brain tool-catalog refresh");
    process.exit(1);
  }
  const { catalog, servers, live, fallback } = await refreshCatalog({ projectDir: process.cwd() });
  console.log(`tool-catalog: ${catalog.tools.length} tools (${live} live from ${servers} servers, ${fallback} from transcripts)`);
}
