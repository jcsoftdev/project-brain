import {
  DEFAULT_SECTION_ID,
  hasSectionMarkers,
  replaceSection,
  stripSection,
} from "../markers.js";

/**
 * Filesystem side of the managed-block convention. The string operations live
 * in src/markers.ts so the OKF exporter shares exactly one marker format.
 */

/**
 * Write content between section markers in a file.
 * If markers already exist, replace the section. Otherwise append.
 * Independent sections (different sectionId) coexist in the same file.
 */
export async function writeSection(
  filePath: string,
  content: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<void> {
  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    // File doesn't exist yet
  }

  await Bun.write(filePath, `${replaceSection(existing, content, sectionId)}\n`);
}

/**
 * Remove the section identified by sectionId from a file.
 * Returns true if a section was found and removed, false otherwise.
 */
export async function removeSection(
  filePath: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<boolean> {
  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    return false;
  }

  if (!hasSectionMarkers(existing, sectionId)) return false;

  await Bun.write(filePath, `${stripSection(existing, sectionId)}\n`);
  return true;
}

/** Returns true if the section identified by sectionId is present in the file. */
export async function hasSection(
  filePath: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<boolean> {
  try {
    return hasSectionMarkers(await Bun.file(filePath).text(), sectionId);
  } catch {
    return false;
  }
}
