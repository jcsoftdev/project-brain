/**
 * What the per-prompt hooks already put into a Claude Code session, so a later prompt does not
 * inject the same snippet or suggestion again: hook output stays in the conversation until it is
 * compacted or cleared.
 *
 * One file per session and hook kind, beside the session's version record. The two prompt hooks run
 * concurrently for the same prompt, so they never share a file. Dedup only runs for a session the
 * routing SessionStart hook recorded, because that hook is what clears these files after a
 * compaction; without it an injection lost to /compact would never come back.
 */
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { pruneOld, sessionFile } from "./session-versions.js";

export type InjectedKind = "search" | "suggest";

const KINDS: InjectedKind[] = ["search", "suggest"];

/** Newest identities kept per file; a session long enough to pass it re-injects its oldest items. */
export const MAX_INJECTED = 500;

export interface InjectedLedger {
  seen: ReadonlySet<string>;
  /** Record identities as injected. Never throws: an unrecorded item is shown again, never lost. */
  remember(keys: string[]): Promise<void>;
}

export const dedupEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PROJECT_BRAIN_CONTEXT_DEDUP !== "0";

const injectedFile = (dataDir: string, sessionId: string, kind: InjectedKind) =>
  sessionFile(dataDir, sessionId).replace(/\.json$/, `.${kind}-injected.json`);

async function readKeys(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** The session's ledger, or null when dedup is off or the session was never recorded at SessionStart. */
export async function openLedger(
  dataDir: string,
  sessionId: string | undefined,
  kind: InjectedKind,
  now: number = Date.now()
): Promise<InjectedLedger | null> {
  if (!sessionId || !dedupEnabled()) return null;
  const known = await stat(sessionFile(dataDir, sessionId)).then(() => true, () => false);
  if (!known) return null;
  const file = injectedFile(dataDir, sessionId, kind);
  const previous = await readKeys(file);
  return {
    seen: new Set(previous),
    remember: async (keys) => {
      if (keys.length === 0) return;
      const merged = [...previous.filter((k) => !keys.includes(k)), ...keys].slice(-MAX_INJECTED);
      try {
        await writeFileAtomic(file, `${JSON.stringify(merged)}\n`);
        await pruneOld(dirname(file), now);
      } catch {
        // Unrecorded: the item may be injected again, which beats losing it.
      }
    },
  };
}

/** Forget every injection of the session: after /compact or /clear none of it is in context any more. */
export async function forgetInjected(dataDir: string, sessionId: string): Promise<void> {
  await Promise.all(KINDS.map((k) => rm(injectedFile(dataDir, sessionId, k), { force: true }).catch(() => {})));
}
