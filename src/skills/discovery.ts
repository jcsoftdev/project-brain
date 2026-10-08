import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";
import { parseDocument } from "../okf/frontmatter.js";

export interface SkillInfo {
  /** `name` for user/project skills, `plugin:name` for plugin skills. */
  name: string;
  description: string;
  /** SKILL.md location and mtime — the identity the vector cache keys on. */
  path?: string;
  mtime?: number;
}

/**
 * A cached list is trusted this long. Directory mtimes catch skills being
 * added or removed, but editing an existing SKILL.md does not touch them, so
 * the TTL bounds how stale a description can get.
 */
export const SKILL_CACHE_TTL_MS = 10 * 60_000;

export interface DiscoverOptions {
  home?: string;
  projectDir: string;
  /** Where the cache file lives. Defaults to DATA_DIR. */
  cacheDir?: string;
  now?: () => number;
  ttlMs?: number;
}

interface SkillRoot {
  dir: string;
  /** `plugin:` for plugin skills, "" otherwise. */
  prefix: string;
}

interface CacheFile {
  builtAt: number;
  fingerprint: string[];
  skills: SkillInfo[];
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Reads one SKILL.md; null when it is unreadable or lacks a usable name/description. */
async function readSkill(file: string, prefix: string): Promise<SkillInfo | null> {
  try {
    const mtime = await mtimeOf(file);
    const fm = parseDocument(await readFile(file, "utf-8")).frontmatter as Record<string, unknown>;
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    const description = typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
    return name && description ? { name: `${prefix}${name}`, description, path: file, mtime } : null;
  } catch {
    return null;
  }
}

interface SkillFile {
  file: string;
  prefix: string;
}

async function listSkillFiles({ dir, prefix }: SkillRoot): Promise<SkillFile[]> {
  try {
    return (await readdir(dir)).sort().map((entry) => ({ file: join(dir, entry, "SKILL.md"), prefix }));
  } catch {
    return [];
  }
}

/** Plugin skill dirs from Claude Code's registry; the plugin name is the part before `@marketplace`. */
async function pluginRoots(registry: string): Promise<SkillRoot[]> {
  try {
    const raw = JSON.parse(await readFile(registry, "utf-8")) as {
      plugins?: Record<string, Array<{ installPath?: unknown }>>;
    };
    return Object.entries(raw.plugins ?? {}).flatMap(([key, installs]) =>
      (installs ?? [])
        .filter((i) => typeof i.installPath === "string")
        .map((i) => ({ dir: join(i.installPath as string, "skills"), prefix: `${key.split("@")[0]}:` }))
    );
  } catch {
    return [];
  }
}

/** Highest precedence first: a project skill shadows a same-named user or plugin one. */
async function skillRoots(home: string, projectDir: string, registry: string): Promise<SkillRoot[]> {
  return [
    { dir: join(projectDir, ".claude", "skills"), prefix: "" },
    { dir: join(home, ".claude", "skills"), prefix: "" },
    { dir: join(home, ".agents", "skills"), prefix: "" },
    ...(await pluginRoots(registry)),
  ];
}

function dedupeByName(skills: SkillInfo[]): SkillInfo[] {
  const seen = new Set<string>();
  return skills.filter((s) => !seen.has(s.name) && seen.add(s.name));
}

/**
 * Lists installed skills, served from an on-disk cache while the skill roots'
 * mtimes are unchanged and the TTL has not lapsed. The hook is a fresh
 * process per prompt, so without the cache every prompt would rescan.
 * Never throws.
 */
export async function discoverSkills(opts: DiscoverOptions): Promise<SkillInfo[]> {
  const home = opts.home ?? homedir();
  const now = (opts.now ?? Date.now)();
  const cacheDir = opts.cacheDir ?? DATA_DIR;
  const registry = join(home, ".claude", "plugins", "installed_plugins.json");
  const cacheFile = join(cacheDir, `skills-${createHash("sha1").update(opts.projectDir).digest("hex").slice(0, 12)}.json`);

  const roots = await skillRoots(home, opts.projectDir, registry);
  const files = (await Promise.all(roots.map(listSkillFiles))).flat();
  // Per-file mtimes, not directory ones: an in-place edit of a SKILL.md
  // leaves its directory's mtime untouched.
  const mtimes = await Promise.all(files.map((f) => mtimeOf(f.file)));
  const fingerprint = [...files.map((f, i) => `${f.file}:${mtimes[i]}`), `registry:${await mtimeOf(registry)}`];

  try {
    const cached = JSON.parse(await readFile(cacheFile, "utf-8")) as CacheFile;
    const fresh = now - cached.builtAt < (opts.ttlMs ?? SKILL_CACHE_TTL_MS);
    if (fresh && Array.isArray(cached.skills) && JSON.stringify(cached.fingerprint) === JSON.stringify(fingerprint)) {
      return cached.skills;
    }
  } catch {
    // Missing or corrupt cache → rescan.
  }

  const read = await Promise.all(files.map((f) => readSkill(f.file, f.prefix)));
  const skills = dedupeByName(read.filter((s): s is SkillInfo => s !== null));
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ builtAt: now, fingerprint, skills } satisfies CacheFile));
  } catch {
    // An unwritable cache only costs a rescan next time.
  }
  return skills;
}
