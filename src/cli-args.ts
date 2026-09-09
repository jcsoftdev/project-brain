/**
 * Pure CLI argument-parsing helpers, split out of cli.ts so they can be unit
 * tested without importing cli.ts itself (which has top-level side effects —
 * it dispatches on process.argv and starts the MCP server on import).
 */

/**
 * Resolve the HTTP listen port for `serve --http`.
 *
 * Fallback chain: --port <n> flag > BRAIN_HTTP_PORT env var > 3000.
 * `indexOf` returns -1 when --port is absent; guarding on that (rather than
 * blindly reading `args[args.indexOf("--port") + 1]`) prevents the next flag
 * (e.g. "--http") from being misread as the port value.
 */
export function parsePort(
  args: string[],
  env: Record<string, string | undefined> = process.env
): number {
  const idx = args.indexOf("--port");
  const value = idx !== -1 ? args[idx + 1] : undefined;
  return Number(value ?? env.BRAIN_HTTP_PORT ?? 3000);
}

/**
 * Resolve the non-interactive override for the opt-in model-routing prompt.
 * "ask" (the default) defers to the interactive TTY confirm at setup time.
 */
export function parseModelRoutingFlag(args: string[]): "ask" | "yes" | "no" {
  if (args.includes("--model-routing")) return "yes";
  if (args.includes("--no-model-routing")) return "no";
  return "ask";
}

/**
 * Resolve the routing-hook flags: whether to install the SessionStart reminder,
 * and whether to add the PreToolUse guard that blocks an unrouted delegation.
 *
 * `--routing-hook-strict` implies installation — asking for the guard and then
 * being prompted whether to install hooks at all is one question too many. An
 * explicit `--no-routing-hook` still wins over it: contradictory flags resolve
 * to the reading that writes nothing.
 */
export function parseRoutingHookFlag(args: string[]): {
  mode: "ask" | "yes" | "no";
  strict: boolean;
} {
  if (args.includes("--no-routing-hook")) return { mode: "no", strict: false };
  if (args.includes("--routing-hook-strict")) return { mode: "yes", strict: true };
  if (args.includes("--routing-hook")) return { mode: "yes", strict: false };
  return { mode: "ask", strict: false };
}

/**
 * Resolve the worktree-hook flags.
 *
 * Installation defaults to yes with no prompt, unlike the routing hooks. Those carry
 * guidance someone can reasonably not want; the reconciling hooks prevent an index that
 * outlives its worktree and a session that does not know its brain is scoped to another
 * branch. Only an explicit opt-out suppresses them.
 *
 * `strict` is the opposite: it adds a PreToolUse guard that blocks a delegation until it
 * states whether it needs isolation, costing one extra turn on every spawn that forgot.
 * That is never a default. `--no-worktree-hook` still wins over it — contradictory flags
 * resolve to the reading that writes nothing.
 */
export function parseWorktreeHookFlag(args: string[]): {
  mode: "yes" | "no";
  strict: boolean;
} {
  if (args.includes("--no-worktree-hook")) return { mode: "no", strict: false };
  if (args.includes("--worktree-hook-strict")) return { mode: "yes", strict: true };
  return { mode: "yes", strict: false };
}

/**
 * Resolve the non-interactive override for the bundled-skill install.
 *
 * Mirrors `parseModelRoutingFlag`, but the default differs downstream: "ask"
 * resolves to INSTALL in a non-interactive context, because the skills are part
 * of what `setup` delivers. Only an explicit opt-out suppresses them.
 *
 * `--brain-audit` / `--no-brain-audit` are kept as aliases: they were the
 * documented names while brain-audit was the only bundled skill, and silently
 * ignoring a flag someone scripted is worse than carrying two spellings.
 */
export function parseSkillInstallFlag(args: string[]): "ask" | "yes" | "no" {
  if (args.includes("--skills") || args.includes("--brain-audit")) return "yes";
  if (args.includes("--no-skills") || args.includes("--no-brain-audit")) return "no";
  return "ask";
}

/**
 * Resolve brain-record's connection-mode preference: which Chrome instance the
 * CDP screencast connects to, and on which port.
 *
 * Defaults to "fresh" — a throwaway, logged-out `--user-data-dir` profile — and
 * NEVER to "live" without the explicit flag. Chrome's own warning on the
 * chrome://inspect toggle "live" requires is the honest cost of that mode: it
 * "allows external apps to request full control of this browser. This includes
 * read access to your saved data, cookies and site data, and the ability to
 * navigate to any URL." A setup default that opts a user into that silently,
 * for convenience, would be the wrong direction to fail in.
 *
 * The port is independent of the mode — either mode can run on a non-default
 * CDP port, e.g. because 9222 is already taken by another debugging session.
 */
export function parseRecordConnectionFlag(args: string[]): {
  mode: "fresh" | "live";
  cdpPort: number;
} {
  const cdpPort = parseIntFlag(args, "--record-cdp-port", { def: 9222, min: 1, max: 65535 });
  const mode = args.includes("--record-connection-live") ? "live" : "fresh";
  return { mode, cdpPort };
}

/**
 * Collect positional (non-flag) arguments, skipping both a valued flag AND
 * its following value. Flags not listed in `valuedFlags` are simply excluded
 * from the positionals themselves — they are not treated as consuming a
 * following value (that following value stays positional).
 */
export function collectPositionals(args: string[], valuedFlags: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valuedFlags.includes(arg)) {
      i++; // skip the flag's value too
      continue;
    }
    if (arg.startsWith("--")) continue;
    positionals.push(arg);
  }
  return positionals;
}

/**
 * Resolve an integer-valued flag: indexOf-based lookup, clamped to
 * [opts.min, opts.max]. Falls back to opts.def when the flag is absent or
 * its value isn't a valid integer.
 */
export function parseIntFlag(
  args: string[],
  flag: string,
  opts: { def: number; min: number; max: number }
): number {
  const idx = args.indexOf(flag);
  const raw = idx !== -1 ? args[idx + 1] : undefined;
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return opts.def;
  return Math.min(Math.max(n, opts.min), opts.max);
}

/**
 * Resolve a string-valued flag. Returns undefined when the flag is absent, has
 * no following value, or is followed by another flag — `--project --budget 500`
 * is a missing value, not a project literally named "--budget".
 */
export function parseStringFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith("-")) return undefined;
  return raw;
}

/**
 * Resolve a comma-separated list flag: finds `flag`'s value, splits on
 * commas, trims each entry, and drops empty entries. Returns undefined when
 * the flag is absent (or has no following value).
 */
export function parseListFlag(args: string[], flag: string): string[] | undefined {
  const idx = args.indexOf(flag);
  const raw = idx !== -1 ? args[idx + 1] : undefined;
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Legacy flag → the unit ids it turns off. The `*` is a group wildcard,
 * expanded against the real id list so a new skill is covered by `--no-skills`
 * the day it ships.
 */
const LEGACY_OFF: Record<string, string> = {
  "--no-skills": "skill:*",
  "--no-brain-audit": "skill:*",
  "--no-model-routing": "guidance:model-routing",
  "--no-routing-hook": "hooks:routing",
  "--no-worktree-hook": "hooks:worktree",
};

/** Expand `group:*` against the known ids; return both results and which patterns matched. */
function expandIds(
  patterns: string[],
  allIds: string[]
): { ids: string[]; matched: Map<string, boolean> } {
  const out = new Set<string>();
  const matched = new Map<string, boolean>();
  for (const pattern of patterns) {
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1);
      let patternMatched = false;
      for (const id of allIds) {
        if (id.startsWith(prefix)) {
          out.add(id);
          patternMatched = true;
        }
      }
      matched.set(pattern, patternMatched);
    } else {
      out.add(pattern);
      matched.set(pattern, true);
    }
  }
  return { ids: [...out], matched };
}

/**
 * Parse a flag that expects a value (e.g. --with=..., --without=...).
 * Scans ALL arguments and accumulates values from EVERY matching occurrence,
 * in argument order. Returns an error if ANY occurrence is bare (no =),
 * even if other occurrences are well-formed — a malformed argument next to
 * a valid one is still malformed, and resolving toward the error is safe.
 */
function parseValuedFlag(
  args: string[],
  flag: string
): { present: boolean; values: string[]; error?: string } {
  let present = false;
  const values: string[] = [];
  let hasBareFlagError = false;

  for (const arg of args) {
    if (arg === flag) {
      present = true;
      hasBareFlagError = true;
    } else if (arg.startsWith(`${flag}=`)) {
      present = true;
      const rawValue = arg.slice(flag.length + 1);
      values.push(...rawValue.split(",").filter(Boolean));
    }
  }

  if (hasBareFlagError) {
    return {
      present: true,
      values: [],
      error: `${flag} requires a value, e.g. ${flag}=skill:brain-audit,hooks:routing`,
    };
  }

  return { present, values };
}

/**
 * Resolve which units a non-interactive run should end up with.
 *
 * `mode: "default"` means no selection flag was given, so the caller falls back
 * to the saved selection or to each unit's own default — that fallback is what
 * keeps a scripted `project-brain setup` with no arguments behaving exactly as
 * it does today.
 *
 * An unknown id is a hard error rather than a silent skip: a typo in a
 * provisioning script would otherwise mean the machine quietly does not get
 * what the script asked for, and nothing would ever say so.
 *
 * When flags conflict, subtraction always wins over addition, and `--none`
 * always wins over `--all`, regardless of argument order. This matches the
 * convention elsewhere in this file (parseRoutingHookFlag): contradictory
 * flags resolve toward installing less, which is the safe direction.
 */
export function parseUnitFlags(
  args: string[],
  allIds: string[]
):
  | { mode: "default" | "explicit"; selected: string[]; error?: undefined }
  | { error: string; mode?: undefined; selected?: undefined } {
  const withResult = parseValuedFlag(args, "--with");
  const withoutResult = parseValuedFlag(args, "--without");

  if (withResult.error) return { error: withResult.error };
  if (withoutResult.error) return { error: withoutResult.error };

  const legacyOff = Object.keys(LEGACY_OFF).filter((f) => args.includes(f));
  const legacyOn =
    args.includes("--skills") || args.includes("--brain-audit") ? ["skill:*"] : [];
  const all = args.includes("--all");
  const none = args.includes("--none");

  const touched =
    withResult.present ||
    withoutResult.present ||
    legacyOff.length > 0 ||
    legacyOn.length > 0 ||
    all ||
    none;

  if (!touched) return { mode: "default", selected: [] };

  const known = new Set(allIds);
  const unknown = [...withResult.values, ...withoutResult.values].filter(
    (id) => !id.endsWith(":*") && !known.has(id)
  );
  if (unknown.length > 0) {
    return {
      error:
        `Unknown setup unit${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}\n` +
        `Valid ids: ${allIds.join(", ")}`,
    };
  }

  // Expand wildcards and check that all patterns matched at least one id
  const withExpanded = expandIds([...withResult.values, ...legacyOn], allIds);
  const withoutExpanded = expandIds(withoutResult.values, allIds);

  for (const [pattern, matched] of withExpanded.matched.entries()) {
    if (pattern.endsWith(":*") && !matched) {
      const validPrefixes = new Set<string>();
      for (const id of allIds) {
        const colon = id.indexOf(":");
        if (colon !== -1) validPrefixes.add(id.slice(0, colon + 1));
      }
      return {
        error:
          `Wildcard pattern '${pattern}' matched no units.\n` +
          `Valid group prefixes: ${[...validPrefixes].sort().join(", ")}`,
      };
    }
  }

  for (const [pattern, matched] of withoutExpanded.matched.entries()) {
    if (pattern.endsWith(":*") && !matched) {
      const validPrefixes = new Set<string>();
      for (const id of allIds) {
        const colon = id.indexOf(":");
        if (colon !== -1) validPrefixes.add(id.slice(0, colon + 1));
      }
      return {
        error:
          `Wildcard pattern '${pattern}' matched no units.\n` +
          `Valid group prefixes: ${[...validPrefixes].sort().join(", ")}`,
      };
    }
  }

  // `--with` is additive from nothing; everything else starts from the full set
  // and subtracts. Subtraction always wins: --none wins over --all, and
  // --without/--no-* wins over --with/legacy-on.
  const startFromNothing = none || (withResult.present && !all);
  const selected = new Set<string>(startFromNothing ? [] : allIds);

  for (const id of withExpanded.ids) selected.add(id);
  for (const id of withoutExpanded.ids) selected.delete(id);
  for (const flag of legacyOff) {
    for (const id of expandIds([LEGACY_OFF[flag]!], allIds).ids) selected.delete(id);
  }

  return { mode: "explicit", selected: allIds.filter((id) => selected.has(id)) };
}
