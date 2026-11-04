import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { transcriptDirName } from "./model.js";

/** Bytes read from the end of a transcript; enough for the last message even when housekeeping entries trail it. */
const TAIL_BYTES = 256 * 1024;

/** Transcript entry types that are conversation turns; everything else (titles, hooks, attachments, system) is housekeeping. */
const MESSAGE_TYPES = new Set(["user", "assistant"]);

interface SessionRecord {
  sessionId?: unknown;
  updatedAt?: unknown;
}

function readJson(path: string): SessionRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return value !== null && typeof value === "object" ? (value as SessionRecord) : null;
  } catch {
    return null;
  }
}

function readTail(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Timestamp of the newest user/assistant entry in a transcript's tail; a line cut by the tail window fails to parse and is skipped. */
export function lastMessageTimestamp(transcriptPath: string): number | null {
  const tail = readTail(transcriptPath);
  if (tail === null) return null;
  let newest: number | null = null;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
      if (typeof entry.type !== "string" || !MESSAGE_TYPES.has(entry.type) || typeof entry.timestamp !== "string") continue;
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    } catch {
      continue;
    }
  }
  return newest;
}

function findTranscript(projectsDir: string, sessionId: string, cwd: string | null): string | null {
  const file = `${sessionId}.jsonl`;
  if (cwd !== null) {
    const direct = join(projectsDir, transcriptDirName(cwd), file);
    if (existsSync(direct)) return direct;
  }
  try {
    const hit = readdirSync(projectsDir).find((dir) => existsSync(join(projectsDir, dir, file)));
    return hit === undefined ? null : join(projectsDir, hit, file);
  } catch {
    return null;
  }
}

/**
 * Epoch ms of the most recent Claude-recorded activity for a session: the later of its registry
 * `updatedAt` and its transcript's last message. File mtimes are never consulted.
 */
export function recordedActivityMs(claudeDir: string, pid: number, cwd: string | null): number | null {
  const record = readJson(join(claudeDir, "sessions", `${pid}.json`));
  const updatedAt = typeof record?.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : null;
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : null;
  const transcript = sessionId === null ? null : findTranscript(join(claudeDir, "projects"), sessionId, cwd);
  const lastMessage = transcript === null ? null : lastMessageTimestamp(transcript);
  const signals = [updatedAt, lastMessage].filter((s): s is number => s !== null);
  return signals.length === 0 ? null : Math.max(...signals);
}
