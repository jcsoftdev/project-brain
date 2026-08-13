import { writeSection, hasSection } from "../rules/section-marker.js";

/** Marker id for the model-routing section inside a host's rules file. */
export const ROUTING_SECTION_ID = "project-brain-model-routing";

/**
 * Read the content version of an already-written routing section.
 *
 * Returns `null` when no section exists, and `1` when one exists WITHOUT a
 * version marker — that is the pre-versioning text, which is by definition
 * stale. Treating it as "unknown, leave it alone" would strand exactly the
 * users this mechanism exists to reach.
 */
export async function readWrittenRoutingVersion(filePath: string): Promise<number | null> {
  if (!(await hasSection(filePath, ROUTING_SECTION_ID))) return null;

  let text: string;
  try {
    text = await Bun.file(filePath).text();
  } catch {
    return null;
  }

  const match = text.match(/model-routing-version:\s*(\d+)/);
  return match ? Number(match[1]) : 1;
}

/** Write (or replace) the model-routing section in a host's rules file. */
export async function writeRoutingSection(filePath: string, content: string): Promise<void> {
  await writeSection(filePath, content, ROUTING_SECTION_ID);
}
