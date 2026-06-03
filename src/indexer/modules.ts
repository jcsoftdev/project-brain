import { join } from "node:path";
import { readdir, stat, mkdir, writeFile, access } from "node:fs/promises";
import { WATCHER_ALWAYS_IGNORE } from "../constants.js";

/** Recognized source extensions that qualify a directory as a module. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".py", ".go", ".rs", ".rb", ".java",
  ".kt", ".swift", ".c", ".cpp", ".h", ".md",
]);

/** Fallback template used when templates/module-doc.md is not on disk. */
const FALLBACK_MODULE_TEMPLATE = `# Module: {{name}}

## Purpose

## Key Files

## Dependencies

## Data Flow

## Gotchas

## Last Updated
`;

/** Strip trailing slash from always-ignore entries for directory name comparison. */
function buildIgnoreSet(): Set<string> {
  return new Set(WATCHER_ALWAYS_IGNORE.map((p) => p.replace(/\/$/, "")));
}

/** Recursively check if a directory contains at least one file with a recognized source extension. */
async function hasSourceFile(dirPath: string): Promise<boolean> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = entry.name.lastIndexOf(".") >= 0
        ? entry.name.slice(entry.name.lastIndexOf("."))
        : "";
      if (SOURCE_EXTENSIONS.has(ext)) {
        return true;
      }
    } else if (entry.isDirectory()) {
      const nested = await hasSourceFile(join(dirPath, entry.name));
      if (nested) return true;
    }
  }
  return false;
}

/**
 * Detect top-level module directories in a project root.
 * A module is a direct child directory that:
 *  1. Is not in WATCHER_ALWAYS_IGNORE
 *  2. Does not start with a dot (hidden dir)
 *  3. Contains at least one file with a recognized source extension (at any depth)
 *
 * Returns directory names sorted lexicographically.
 */
export async function detectModules(root: string): Promise<string[]> {
  const ignoreSet = buildIgnoreSet();

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries.filter(
    (e) =>
      e.isDirectory() &&
      !e.name.startsWith(".") &&
      !ignoreSet.has(e.name)
  );

  const modules: string[] = [];
  for (const dir of candidates) {
    const full = join(root, dir.name);
    if (await hasSourceFile(full)) {
      modules.push(dir.name);
    }
  }

  return modules.sort();
}

/**
 * Write module stub files to docs/modules/<module>.md for each module.
 * Skips modules where the stub already exists (idempotency rule).
 * Returns the list of file paths actually created.
 */
export async function writeModuleStubs(
  root: string,
  modules: string[],
  info: { projectId: string }
): Promise<string[]> {
  if (modules.length === 0) return [];

  // Load template — try templates/module-doc.md relative to this file's location,
  // then fall back to the inline constant.
  const templatePath = join(import.meta.dir, "../../templates/module-doc.md");
  let template: string;
  try {
    template = await Bun.file(templatePath).text();
  } catch {
    template = FALLBACK_MODULE_TEMPLATE;
  }

  const docsModulesDir = join(root, "docs", "modules");
  await mkdir(docsModulesDir, { recursive: true });

  const created: string[] = [];

  for (const mod of modules) {
    const stubPath = join(docsModulesDir, `${mod}.md`);

    // Check if stub already exists — skip if so
    try {
      await access(stubPath);
      // File exists — skip
      continue;
    } catch {
      // File does not exist — proceed
    }

    const content = template.replace(/\{\{name\}\}/g, mod);
    await writeFile(stubPath, content, "utf-8");
    created.push(stubPath);
  }

  return created;
}
