/**
 * What the per-prompt hooks already put into the live conversation, read from the Claude Code
 * transcript rather than from a record of our own: hook output stays in context until the session
 * compacts, clears, rewinds or edits an earlier message, and the transcript is the only place that
 * knows which of those happened. Walking the `parentUuid` chain from the newest entry visits exactly
 * the messages still in context; a compaction boundary has no parent, so the walk stops there.
 *
 * Anything unreadable resolves to null, which callers treat as "nothing shown yet": a duplicate
 * snippet costs a few tokens, a snippet wrongly withheld costs the answer.
 */

/** Only the newest part of the transcript is read; an injection older than this is shown again. */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

export const dedupEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PROJECT_BRAIN_CONTEXT_DEDUP !== "0";

interface Entry {
  parent: string | null;
  texts: string[];
}

function hookTexts(attachment: unknown): string[] {
  if (typeof attachment !== "object" || attachment === null) return [];
  const a = attachment as Record<string, unknown>;
  if (a.hookEvent !== "UserPromptSubmit") return [];
  const values = [a.stdout, ...(Array.isArray(a.content) ? a.content : [a.content])];
  return values.filter((v): v is string => typeof v === "string");
}

function parseEntry(line: string): [string, Entry] | null {
  if (!line.slice(0, 200).includes('"parentUuid"')) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.uuid !== "string") return null;
    const parent = typeof o.parentUuid === "string" ? o.parentUuid : null;
    return [o.uuid, { parent, texts: o.type === "attachment" ? hookTexts(o.attachment) : [] }];
  } catch {
    return null;
  }
}

/**
 * Every UserPromptSubmit hook output still in the live conversation, joined by newlines. Null when
 * dedup is off, there is no transcript, or it holds no conversation chain.
 */
export async function liveHookOutput(transcriptPath: string | undefined, tailBytes = TRANSCRIPT_TAIL_BYTES): Promise<string | null> {
  if (!transcriptPath || !dedupEnabled()) return null;
  try {
    const file = Bun.file(transcriptPath);
    const text = await file.slice(Math.max(0, file.size - tailBytes)).text();
    const entries = new Map<string, Entry>();
    let leaf: string | undefined;
    for (const line of text.split("\n")) {
      const parsed = parseEntry(line);
      if (!parsed) continue;
      entries.set(parsed[0], parsed[1]);
      leaf = parsed[0];
    }
    if (!leaf) return null;

    const shown: string[] = [];
    const visited = new Set<string>();
    for (let id: string | null = leaf; id !== null && !visited.has(id); ) {
      const entry = entries.get(id);
      if (!entry) break;
      visited.add(id);
      shown.push(...entry.texts);
      id = entry.parent;
    }
    return shown.join("\n");
  } catch {
    return null;
  }
}

/** The search block's score varies per prompt for the same snippet, so it is not part of what was shown. */
export const withoutScores = (text: string): string => text.replace(/ \[score \d+(?:\.\d+)?\]/g, "");
