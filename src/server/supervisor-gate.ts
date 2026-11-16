// Which invocations run behind the hot-swap supervisor. Imported by cli.ts before anything else, on
// every command, so it imports nothing.

/**
 * Only the long-lived stdio server: `serve` (or no command, which is how MCP hosts start it). Never
 * `serve --http`, never the worker itself, and never a one-shot command or hook. On by default;
 * `BRAIN_MCP_HOT_SWAP=0` runs the server in-process.
 */
export function wantsSupervisor(command: string | undefined, args: string[], env: Record<string, string | undefined>): boolean {
  if (command !== undefined && command !== "serve") return false;
  if (args.includes("--http") || args.includes("--worker")) return false;
  return env.BRAIN_MCP_HOT_SWAP !== "0";
}
