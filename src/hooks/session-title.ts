/**
 * Session title: let the agent name the conversation it is in.
 *
 * Claude Code already derives a name for every session and records it in the transcript
 * as `ai-title`; `/rename` records a `custom-title`, which outranks it everywhere the
 * session is listed. `/rename` is typed by a human, though — there is no tool and no
 * hook field that lets the agent set it, so a session whose subject drifted keeps the
 * name it earned in its first few turns.
 *
 * The split here is deliberate: JUDGEMENT comes from the agent, IDENTITY from the hook.
 * A shell hook cannot know what the work is about, and the agent cannot know its own
 * session id or transcript path. So the agent writes a name into a file in its own
 * scratchpad, and this hook — which gets `session_id`, `transcript_path` and
 * `scratchpad_dir` in the Stop payload — turns it into the record the app reads back.
 *
 * Appending is how the app itself maintains that record: it re-emits `custom-title` on
 * every save and resolves the title with `findLast`, so one more line of the same shape
 * is the documented-by-behaviour way in, not a poke at a private structure.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A session name is a label, not a summary. Ten words is already generous. */
export const MAX_TITLE_WORDS = 10;

/** The file the agent writes its chosen name to, inside its own scratchpad. */
export const TITLE_FILE = "session-title";

/** What a decision needs to read, so the decision itself stays pure. */
export interface TitleSources {
  /** The name the agent chose, or null when it has not chosen one. */
  name(): string | null;
  /** The transcript as text, or "" when it cannot be read. */
  transcript(): string;
}

/** The append this hook would make. */
export interface TitleDecision {
  transcriptPath: string;
  line: string;
}

/**
 * One line, at most `MAX_TITLE_WORDS` words, or null when there is no name at all.
 *
 * Splitting on whitespace rather than trimming per character is what keeps a stray tab
 * or newline out of the JSONL record, where it would end the line early.
 */
export function normalizeTitle(raw: string): string | null {
  const words = raw.split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS);
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * The title currently in force, or null when only a derived one exists.
 *
 * `findLast`, because the app appends rather than rewrites — the first record in a long
 * transcript is usually a name the session outgrew several renames ago.
 */
export function currentCustomTitle(transcript: string): string | null {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"type":"custom-title"')) continue;
    try {
      const parsed = JSON.parse(line) as { customTitle?: unknown };
      if (typeof parsed.customTitle === "string" && parsed.customTitle) return parsed.customTitle;
    } catch {
      // A truncated last line is normal while the app is writing. Keep looking back.
    }
  }
  return null;
}

/** The record the app reads back with its own `findLast` scan. */
export function titleRecord(sessionId: string, title: string): string {
  return JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
}

/** A string field of the hook payload, or "" when it is missing or the wrong shape. */
function field(payload: unknown, key: string): string {
  if (typeof payload !== "object" || payload === null) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * The append to make for this Stop event, or null to stay quiet.
 *
 * Null on an unchanged name is the load-bearing case, not an optimisation: Stop fires on
 * every turn, and re-appending the same title would grow the transcript by a line per
 * turn for a value nobody read differently.
 */
export function decideSessionTitle(payload: unknown, sources: TitleSources): TitleDecision | null {
  const sessionId = field(payload, "session_id");
  const transcriptPath = field(payload, "transcript_path");
  if (!sessionId || !transcriptPath || !field(payload, "scratchpad_dir")) return null;

  const chosen = sources.name();
  if (chosen === null) return null;

  const title = normalizeTitle(chosen);
  if (!title || title === currentCustomTitle(sources.transcript())) return null;

  return { transcriptPath, line: titleRecord(sessionId, title) };
}

/**
 * Read what the agent chose, and record it if it is new.
 *
 * Every failure is swallowed. A hook must never break the turn it is attached to, and
 * the worst case here is a session that keeps a name one turn longer than it should.
 */
export async function applySessionTitle(payload: unknown): Promise<void> {
  const scratchpad = field(payload, "scratchpad_dir");
  if (!scratchpad) return;

  let name: string | null = null;
  try {
    name = await readFile(join(scratchpad, TITLE_FILE), "utf8");
  } catch {
    return; // no name file is the normal case, not an error
  }

  let transcript = "";
  try {
    transcript = await readFile(field(payload, "transcript_path"), "utf8");
  } catch {
    // An unreadable transcript only means we cannot tell the title is unchanged.
  }

  const decision = decideSessionTitle(payload, { name: () => name, transcript: () => transcript });
  if (!decision) return;

  try {
    await appendFile(decision.transcriptPath, `${decision.line}\n`);
  } catch {
    // Nothing to recover: the next turn tries again with the same name.
  }
}

/**
 * The SessionStart payload that tells the agent this hook exists.
 *
 * Without it the mechanism is inert: nothing else in the session says that a file in the
 * scratchpad becomes the session's name. Kept to a few lines because it is paid on every
 * session start, and the scratchpad path is already in the agent's own context.
 */
export function buildTitleNotice(): string {
  const additionalContext = [
    `Name this session after the work. Write the name to \`${TITLE_FILE}\` in your ` +
      `scratchpad directory: at most ${MAX_TITLE_WORDS} words, describing what is being ` +
      "worked on rather than what was asked. Rewrite that file when the subject moves on.",
    "A project-brain hook records it as the session's title at the end of the turn. " +
      "Do not announce this and do not run `/rename` — you cannot, and the file is enough.",
  ].join("\n");

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  });
}

/**
 * CLI entry point for both events this feature is wired to.
 *
 * `notice` on SessionStart states the rule, `apply` on Stop enforces it. Neither may
 * fail the thing it is attached to, so every path here ends quietly.
 */
export async function execute(args: string[] = []): Promise<void> {
  const mode = args.find((a) => !a.startsWith("--")) ?? "apply";

  if (mode === "notice") {
    try {
      console.log(buildTitleNotice());
    } catch {
      // Say nothing rather than start a session with an error.
    }
    return;
  }

  try {
    await applySessionTitle(JSON.parse(await Bun.stdin.text()));
  } catch {
    // Unreadable stdin, or no stdin at all — say nothing.
  }
}
