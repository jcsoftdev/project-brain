const START_MARKER = "<!-- project-brain:start -->";
const END_MARKER = "<!-- project-brain:end -->";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write content between section markers in a file.
 * If markers already exist, replace the section. Otherwise append.
 */
export async function writeSection(
  filePath: string,
  content: string
): Promise<void> {
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
 * Remove the project-brain section from a file.
 * Returns true if a section was found and removed, false otherwise.
 */
export async function removeSection(filePath: string): Promise<boolean> {
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
