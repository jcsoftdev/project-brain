/**
 * SessionStart hook: inject the model-routing rules once per session.
 *
 * SessionStart is one of the few events that accept `additionalContext`
 * (with UserPromptSubmit and PostToolUse) — and the only one of those that
 * fires once rather than once per prompt. Written guidance in a rules file can
 * be skimmed past; this lands in context every session, at a cost paid once.
 *
 * Output is capped at 10,000 characters by the host. That is a ceiling, not a
 * budget: what goes in is the table and the label rule, because the session
 * pays for every character. The prose lives in the rules file.
 *
 * That rules file is Claude Code's own `~/.claude/CLAUDE.md` — which Claude
 * Code already loads into every session on its own, hook or no hook. So once
 * the `guidance:model-routing` setup unit has written a CURRENT section
 * there, a full second copy from this hook is the same ~2.5K-token table paid
 * twice per session for no new information. Only an absent or stale section
 * (not yet written, or written by an older release) still needs the hook to
 * say the whole thing; once it is current, a one-line pointer is enough to
 * prove the hook ran without re-paying for the table.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ROUTING_TIERS, DEFAULT_HOST_MODELS, ROUTING_CONTENT_VERSION } from "../constants.js";
import { loadRoutingConfig } from "../rules/model-routing-config.js";
import { readWrittenRoutingVersion } from "../registrars/routing-section.js";

/**
 * Build the SessionStart hook payload as a JSON string.
 *
 * `rulesPath` is injectable for tests, which must not read or write the real
 * `~/.claude/CLAUDE.md` — the same reason `configPath` is injectable.
 */
export async function buildRoutingReminder(
  configPath?: string,
  rulesPath?: string,
  /** Spell out the table even when the rules file is current: a session that predates an update never reloaded it. */
  forceFull = false
): Promise<string> {
  const resolvedRulesPath = rulesPath ?? join(homedir(), ".claude", "CLAUDE.md");
  const writtenVersion = await readWrittenRoutingVersion(resolvedRulesPath);

  if (!forceFull && writtenVersion !== null && writtenVersion >= ROUTING_CONTENT_VERSION) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          'Model routing for delegated agents: the "Model routing for delegated agents" table ' +
          "in this project's rules file is current — follow it; not repeated here.",
      },
    });
  }

  const resolved = await loadRoutingConfig(configPath);
  const models = resolved.models.claude ?? DEFAULT_HOST_MODELS.claude!;

  const tiers = ROUTING_TIERS.map((t) => `- ${t.tier}: ${t.meaning}`).join("\n");
  const named = Object.values(models).some((m) => m !== null);
  const header = named ? "| Task | Tier | Model | Why |" : "| Task | Tier | Why |";
  const separator = named ? "| --- | --- | --- | --- |" : "| --- | --- | --- |";
  const rows = resolved.rules.map((r) =>
    named
      ? `| ${r.task} | ${r.tier} | ${models[r.tier] ?? "—"} | ${r.why} |`
      : `| ${r.task} | ${r.tier} | ${r.why} |`
  );

  const additionalContext = [
    "Model routing for delegated agents — pick a sub-agent's model deliberately.",
    "",
    tiers,
    "",
    [header, separator, ...rows].join("\n"),
    "",
    "Pass `model` on the delegation call, and prefix the description with it " +
      "(`haiku: locate auth handler`) so the choice is visible. Raise reasoning effort " +
      "before raising tier. Delegate only when the work is 4+ files or a read-then-write " +
      "pair; 1-3 files to decide is cheaper inline.",
  ].join("\n");

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

/**
 * CLI entry point: print the payload for the SessionStart hook.
 *
 * Also the carrier of the one-time suggest-hook upgrade (see hooks/suggest-hook.ts).
 * It stays silent: stdout is the hook's JSON payload.
 */
export async function execute(
  selfInstall: () => Promise<unknown> = async () => {
    const { DATA_DIR } = await import("../constants.js");
    const { selfInstallSuggestHook } = await import("./suggest-hook.js");
    return selfInstallSuggestHook({
      // BRAIN_CLAUDE_SETTINGS exists because Bun's homedir() ignores a runtime HOME (see commands/setup.ts).
      settingsPath: process.env.BRAIN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json"),
      dataDir: DATA_DIR,
    });
  },
  readSessionId: () => Promise<string | undefined> = readSessionIdFromStdin,
  dataDir?: string
): Promise<void> {
  // Never let a hook failure interrupt a session start — print nothing and go.
  try {
    await selfInstall().catch(() => {});
    await recordThisSession(readSessionId, dataDir).catch(() => {});
    console.log(await buildRoutingReminder());
  } catch {
    process.exit(0);
  }
}

/** The hook's JSON arrives on stdin; a terminal (someone running the command by hand) has none to wait for. */
async function readSessionIdFromStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  // The host closes the pipe right after writing, so this normally returns at once; the timer only
  // bounds a pipe that stays open, and is cleared so it never outlives the read.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raw = await Promise.race([
    Bun.stdin.text().catch(() => ""),
    new Promise<string>((resolve) => (timer = setTimeout(() => resolve(""), 500))),
  ]);
  clearTimeout(timer);
  try {
    const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Remember which version this session started on, so the first prompt after an update can say so once. */
async function recordThisSession(readSessionId: () => Promise<string | undefined>, dataDir?: string): Promise<void> {
  const sessionId = await readSessionId();
  if (!sessionId) return;
  const { DATA_DIR, VERSION } = await import("../constants.js");
  const { recordSession } = await import("./session-versions.js");
  await recordSession(dataDir ?? DATA_DIR, sessionId, VERSION);
}
