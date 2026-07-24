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
