function markers(sectionId: string): { start: string; end: string } {
  return {
    start: `<!-- ${sectionId}:start -->`,
    end: `<!-- ${sectionId}:end -->`,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write content between section markers in a file.
 * If markers already exist, replace the section. Otherwise append.
 * Independent sections (different sectionId) coexist in the same file.
 */
export async function writeSection(
  filePath: string,
  content: string,
  sectionId = "project-brain"
): Promise<void> {
  const { start: START_MARKER, end: END_MARKER } = markers(sectionId);
  const section = `${START_MARKER}\n${content}\n${END_MARKER}`;
  let existing = "";

  try {
    existing = await Bun.file(filePath).text();
  } catch {
    // File doesn't exist yet
  }

  if (existing.includes(START_MARKER)) {
    // Replace existing section
    const regex = new RegExp(
      `${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`
    );
    await Bun.write(filePath, existing.replace(regex, section));
  } else if (existing.length === 0) {
    // New file
    await Bun.write(filePath, section + "\n");
  } else {
    // Append with spacing
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await Bun.write(filePath, existing + separator + section + "\n");
  }
}

/**
 * Remove the section identified by sectionId from a file.
 * Returns true if a section was found and removed, false otherwise.
 */
export async function removeSection(
  filePath: string,
  sectionId = "project-brain"
): Promise<boolean> {
  const { start: START_MARKER, end: END_MARKER } = markers(sectionId);
  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    return false;
  }

  if (!existing.includes(START_MARKER)) {
    return false;
  }

  const regex = new RegExp(
    `\\n*${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}\\n*`
  );
  await Bun.write(filePath, existing.replace(regex, "\n"));
  return true;
}

/** Returns true if the section identified by sectionId is present in the file. */
export async function hasSection(
  filePath: string,
  sectionId = "project-brain"
): Promise<boolean> {
  const { start: START_MARKER } = markers(sectionId);
  try {
    const existing = await Bun.file(filePath).text();
    return existing.includes(START_MARKER);
  } catch {
    return false;
  }
}
