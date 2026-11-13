/**
 * Whether this process may write the user's global state (installed skills, host
 * MCP configs, ~/.claude/settings.json hooks) from what THIS build carries.
 *
 * Only an installed build may. Every install channel (Homebrew, the npm/bun shim,
 * the install script, a dropped-in binary) runs the `bun build --compile` binary,
 * whose entry point lives in Bun's embedded filesystem (`/$bunfs/...`, or
 * `B:\~BUN\...` on Windows). Any other entry point is a checkout run from source:
 * a worktree, a feature branch, the main checkout. Writing from there pushes
 * unreleased content into every session on the machine.
 *
 * The entry point is the signal because it holds for every checkout. A git
 * worktree check would miss the main checkout on a feature branch, and the
 * version string carries no dev marker (it is package.json's release number).
 */

/** Unlocks the global writes from a source checkout, for the maintainer. */
export const FORCE_GLOBAL_WRITES_ENV = "BRAIN_FORCE_SKILL_REFRESH";

/** The Bun entry point of a compiled binary, matched the same way as parser/pool.ts. */
export function isCompiledEntry(main: string): boolean {
  return main.includes("$bunfs") || main.includes("~BUN") || main.includes("%7EBUN");
}

export type GlobalWriteStep = "skill-refresh" | "config-repair" | "suggest-hook";

/** Each step's own opt-out, which beats the force override. */
const OPT_OUT_ENV: Partial<Record<GlobalWriteStep, string>> = {
  "skill-refresh": "BRAIN_NO_SKILL_REFRESH",
  "config-repair": "BRAIN_NO_CONFIG_REPAIR",
};

export function mayWriteGlobalState(
  step: GlobalWriteStep,
  main: string = Bun.main,
  env: Record<string, string | undefined> = process.env
): boolean {
  const optOut = OPT_OUT_ENV[step];
  if (optOut && env[optOut]) return false;
  if (env[FORCE_GLOBAL_WRITES_ENV] === "1") return true;
  return isCompiledEntry(main);
}
