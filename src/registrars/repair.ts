import { launchCommand, upsertJsonConfig } from "./json-config.js";
import { getRegistrars, type AIToolRegistrar } from "./types.js";

/**
 * Repair a stale `bun <compiled-binary>` MCP entry written by setup before
 * launchCommand() existed.
 *
 * This cannot live in the MCP server's own startup: a config with the broken
 * command never launches the server at all, so nothing inside it ever runs.
 * The repair has to be driven from a plain CLI invocation, which executes the
 * binary directly and bypasses the config entirely.
 *
 * Returns the repaired entry, or null when there is nothing to fix. Null is
 * the answer for every shape we are not certain about — a wrong rewrite of a
 * working config is worse than leaving a broken one for setup to replace.
 */
export function repairLaunchEntry(
  entry: Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof entry !== "object" || entry === null) return null;
  if (entry.command !== "bun") return null;

  const args = entry.args;
  // Exactly one arg is the shape setup wrote. Anything else — extra runtime
  // flags, an empty list — is a customization we must not touch.
  if (!Array.isArray(args) || args.length !== 1) return null;

  const serverPath = args[0];
  if (typeof serverPath !== "string") return null;

  const repaired = launchCommand(serverPath);
  // Still bun-launched means it is a real source entrypoint — correct as-is.
  if (repaired.command === "bun") return null;

  return { ...entry, command: repaired.command, args: repaired.args };
}

/**
 * Repair the project-brain entry inside one host config file.
 *
 * Returns true only when a write actually happened, so callers can stay silent
 * on the overwhelmingly common no-op case.
 *
 * Every failure mode here — absent file, unparseable JSON, missing entry, entry
 * we do not recognise — returns false and writes nothing. A repair pass runs
 * unattended on someone else's config; refusing to act is always the safe
 * branch, and setup remains the explicit path that rewrites wholesale.
 */
export async function repairConfigFile(
  configPath: string,
  containerKey: string
): Promise<boolean> {
  let raw: string;
  try {
    raw = await Bun.file(configPath).text();
  } catch {
    return false; // absent, or unreadable — nothing to repair
  }

  let config: Record<string, any>;
  try {
    config = JSON.parse(raw);
  } catch {
    // Unparseable (mid-edit, or JSONC). upsertJsonConfig would throw here;
    // a background repair must not surface that as a failure.
    return false;
  }

  const entry = config?.[containerKey]?.["project-brain"];
  if (!entry) return false;

  const repaired = repairLaunchEntry(entry);
  if (!repaired) return false;

  await upsertJsonConfig(configPath, (c) => {
    c[containerKey]["project-brain"] = repaired;
  });
  return true;
}

/**
 * Repair every host config that still carries the stale `bun <binary>` launch.
 *
 * Returns the names of hosts actually repaired — empty on the common healthy
 * path, so a caller can print nothing at all.
 *
 * One host's broken config must never stop the others from being fixed, so
 * each is isolated: a registrar that throws is skipped, not propagated.
 */
export async function repairAllConfigs(
  registrars?: AIToolRegistrar[]
): Promise<string[]> {
  const list = registrars ?? (await getRegistrars());
  const repaired: string[] = [];

  for (const registrar of list) {
    try {
      const target = registrar.mcpConfigTarget?.();
      if (!target) continue; // Codex (TOML via its own CLI) and anything new
      if (await repairConfigFile(target.path, target.containerKey)) {
        repaired.push(registrar.name);
      }
    } catch {
      // A single unreadable/exotic config is not worth failing the pass over.
      continue;
    }
  }

  return repaired;
}
