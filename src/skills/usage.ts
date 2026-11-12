import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

/**
 * How often each skill was invoked in recent Claude Code transcripts, for the compact skill
 * listing: `~/.project-brain/skill-usage.json`, which the project-brain-skill-listing mod reads.
 */
export interface SkillUsage {
  generatedAt: number;
  windowDays: number;
  /** Invocations by skill name: the Skill tool, and slash commands (built-in commands included; the mod only ranks listed skills). */
  skills: Record<string, { count: number; lastUsed: number }>;
  scanned: { files: number; bytes: number; truncated: boolean };
}

export const SKILL_USAGE_FILE = "skill-usage.json";
export const USAGE_WINDOW_DAYS = 30;
/** Newest transcripts first, until this many bytes are read: a month of heavy use can run to gigabytes. */
export const USAGE_MAX_BYTES = 8 * 1024 ** 3;
export const USAGE_MAX_AGE_MS = 24 * 60 * 60_000;
/** A refresh that died leaves its lock behind; past this age the lock no longer stops the next one. */
const LOCK_STALE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export const skillUsagePath = (dataDir: string): string => join(dataDir, SKILL_USAGE_FILE);

interface Transcript {
  file: string;
  mtime: number;
  size: number;
}

async function transcripts(dir: string): Promise<Transcript[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Transcript[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await transcripts(path)));
    else if (entry.name.endsWith(".jsonl")) {
      const st = await stat(path).catch(() => null);
      if (st) out.push({ file: path, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

const SKILL_MARKER = Buffer.from('"name":"Skill"');
const COMMAND_MARKER = Buffer.from("<command-name>/");
const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/g;
const NEWLINE = 0x0a;

/** Each line of `bytes` holding `marker`, decoded alone, so a multi-gigabyte month is searched without decoding it. */
function* linesWith(bytes: Buffer, marker: Buffer): Generator<string> {
  let from = 0;
  while (true) {
    const hit = bytes.indexOf(marker, from);
    if (hit < 0) return;
    const start = bytes.lastIndexOf(NEWLINE, hit) + 1;
    const newline = bytes.indexOf(NEWLINE, hit);
    const end = newline < 0 ? bytes.length : newline;
    yield bytes.toString("utf8", start, end);
    from = end + 1;
  }
}

interface Invocation {
  /** Same call seen again in a resumed or forked session's copy of the history. */
  key: string;
  skill: string;
  at: number;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const timeOf = (record: Record<string, unknown>, fallback: number): number => {
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return Number.isNaN(at) ? fallback : at;
};

function skillToolCalls(line: string, fallback: number): Invocation[] {
  const record = parseLine(line);
  const content = (record?.message as { content?: unknown } | undefined)?.content;
  if (!record || !Array.isArray(content)) return [];
  const at = timeOf(record, fallback);
  return content.flatMap((block: { type?: unknown; id?: unknown; name?: unknown; input?: { skill?: unknown } }) =>
    block?.type === "tool_use" && block.name === "Skill" && typeof block.input?.skill === "string" && block.input.skill !== ""
      ? [{ key: `tool:${String(block.id)}`, skill: block.input.skill, at }]
      : []
  );
}

function slashCommands(line: string, fallback: number): Invocation[] {
  const record = parseLine(line);
  if (!record || record.type !== "user") return [];
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block: { type?: unknown; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n")
        : "";
  const at = timeOf(record, fallback);
  return [...text.matchAll(COMMAND_NAME)].map((match, index) => ({ key: `command:${String(record.uuid)}:${index}`, skill: match[1]!, at }));
}

export interface ScanOptions {
  projectsRoot: string;
  now?: number;
  windowDays?: number;
  maxBytes?: number;
}

/** Skill invocations in the transcripts touched within the window, newest first and bounded by bytes read. */
export async function scanSkillUsage(opts: ScanOptions): Promise<SkillUsage> {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? USAGE_WINDOW_DAYS;
  const maxBytes = opts.maxBytes ?? USAGE_MAX_BYTES;
  const since = now - windowDays * DAY_MS;
  const recent = (await transcripts(opts.projectsRoot)).filter((t) => t.mtime >= since).sort((a, b) => b.mtime - a.mtime);

  const skills: SkillUsage["skills"] = {};
  const seen = new Set<string>();
  let bytes = 0;
  let files = 0;
  let truncated = false;
  for (const transcript of recent) {
    if (bytes + transcript.size > maxBytes) {
      truncated = true;
      break;
    }
    const content = await readFile(transcript.file).catch(() => null);
    if (!content) continue;
    bytes += content.length;
    files++;
    const invocations = [
      ...[...linesWith(content, SKILL_MARKER)].flatMap((line) => skillToolCalls(line, transcript.mtime)),
      ...[...linesWith(content, COMMAND_MARKER)].flatMap((line) => slashCommands(line, transcript.mtime)),
    ];
    for (const { key, skill, at } of invocations) {
      if (at < since || seen.has(key)) continue;
      seen.add(key);
      const entry = (skills[skill] ??= { count: 0, lastUsed: 0 });
      entry.count++;
      entry.lastUsed = Math.max(entry.lastUsed, at);
    }
  }
  return { generatedAt: now, windowDays, skills, scanned: { files, bytes, truncated } };
}

export async function readSkillUsage(dataDir: string): Promise<SkillUsage | null> {
  try {
    const parsed = JSON.parse(await readFile(skillUsagePath(dataDir), "utf8")) as SkillUsage;
    return typeof parsed.generatedAt === "number" && typeof parsed.skills === "object" && parsed.skills !== null ? parsed : null;
  } catch {
    return null;
  }
}

export interface RefreshOptions extends ScanOptions {
  dataDir: string;
  /** Skip the scan when the file is younger than this. Zero always scans. */
  maxAgeMs?: number;
}

/**
 * Rewrites the usage file unless it is fresh, or another refresh holds the lock: several sessions
 * starting together must not each read a month of transcripts. Resolves to what was written, or null.
 */
export async function refreshSkillUsage(opts: RefreshOptions): Promise<SkillUsage | null> {
  const now = opts.now ?? Date.now();
  const existing = await readSkillUsage(opts.dataDir);
  if (existing && now - existing.generatedAt < (opts.maxAgeMs ?? USAGE_MAX_AGE_MS)) return null;

  const lock = `${skillUsagePath(opts.dataDir)}.lock`;
  const lockAge = await stat(lock).then((st) => now - st.mtimeMs, () => null);
  if (lockAge !== null && lockAge < LOCK_STALE_MS) return null;
  if (lockAge !== null) await rm(lock, { force: true });
  await mkdir(opts.dataDir, { recursive: true });
  const handle = await open(lock, "wx").catch(() => null);
  if (!handle) return null;
  try {
    await handle.close();
    const usage = await scanSkillUsage({ ...opts, now });
    await writeFileAtomic(skillUsagePath(opts.dataDir), `${JSON.stringify(usage, null, 2)}\n`);
    return usage;
  } finally {
    await rm(lock, { force: true });
  }
}
