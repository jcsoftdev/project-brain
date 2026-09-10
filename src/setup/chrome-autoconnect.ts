/**
 * The one flag that decides WHICH Chrome a host's browser tools drive.
 *
 * Without `--autoConnect`, the chrome-devtools MCP launches its own throwaway
 * profile — logged out, isolated, nothing of the user's in it. With the flag it
 * attaches to the Chrome the user is already signed into, which is the only way
 * a flow behind a login can be driven at all, and is also full control of that
 * browser. It is the same trade `brain-record`'s "live" mode makes, so it is
 * offered on the same terms: opt-in, never a default, and always shown next to
 * Chrome's own warning rather than a paraphrase of it.
 *
 * The flag alone does nothing. Chrome will not accept the connection until the
 * user flips the remote-debugging toggle in their own browser, and nothing here
 * can (or should) flip it for them.
 */

/** Where the user — never this tool — turns remote debugging on. */
export const TOGGLE_URL = "chrome://inspect/#remote-debugging";

/**
 * Chrome's own text on that toggle, quoted rather than summarised. Confirmed
 * present in Chrome 152; also quoted in brain-record's pitfalls reference.
 */
export const REMOTE_DEBUGGING_WARNING =
  'Chrome\'s warning on that toggle: it "allows external apps to request full control of ' +
  'this browser. This includes read access to your saved data, cookies and site data, and ' +
  'the ability to navigate to any URL."';

/** What the flag looks like when we write it. Both spellings are read back. */
const CANONICAL_FLAG = "--autoConnect";

/**
 * Flags chrome-devtools-mcp cannot combine with `--autoConnect`, per its own
 * `--help`: `--browserUrl` and `--wsEndpoint` already name a browser to attach
 * to, and the extension/PWA tool categories require a pipe connection.
 */
const CONFLICTING = new Set(["browserurl", "wsendpoint", "categoryextensions", "categorypwa"]);
const CONFLICTING_SHORT = new Set(["-u", "-w"]);

/** `--auto-connect=false` and `--autoConnect` are one name with two spellings. */
function parseFlag(arg: string): { name: string; value: string | null } | null {
  if (typeof arg !== "string" || !arg.startsWith("-")) return null;
  const eq = arg.indexOf("=");
  const raw = eq === -1 ? arg : arg.slice(0, eq);
  const value = eq === -1 ? null : arg.slice(eq + 1);
  return { name: raw.replace(/^-+/, "").replace(/-/g, "").toLowerCase(), value };
}

function argsOf(entry: any): string[] {
  return Array.isArray(entry?.args) ? entry.args : [];
}

/**
 * Whether an MCP server entry runs chrome-devtools-mcp.
 *
 * Matched on the package name in the command or its arguments, NOT on the key
 * the entry is filed under: that key is the user's own label ("chrome",
 * "chrome-devtools", "browser"), and keying off it would miss the entry
 * whenever the user named it something else.
 */
export function isChromeDevtoolsEntry(entry: unknown): boolean {
  const e = entry as any;
  if (!e || typeof e !== "object") return false;
  const tokens = [typeof e.command === "string" ? e.command : "", ...argsOf(e)];
  return tokens.some((t) => typeof t === "string" && t.toLowerCase().includes("chrome-devtools-mcp"));
}

/** Every chrome-devtools entry in one host's config, as [name, entry] pairs. */
export function findChromeDevtoolsEntries(
  config: Record<string, any>,
  containerKey: string
): Array<[string, any]> {
  const container = config?.[containerKey];
  if (!container || typeof container !== "object") return [];
  return Object.entries(container).filter(([, entry]) => isChromeDevtoolsEntry(entry));
}

/**
 * `present` — already connects to the user's Chrome.
 * `missing`  — could, and the flag is all that is needed.
 * `unsupported` — leave it alone: either the user said no explicitly
 * (`--no-auto-connect`, `--autoConnect=false`), or the entry carries a flag
 * chrome-devtools cannot combine with autoConnect. Both are answers already
 * given, and overwriting either would be us deciding for the user.
 */
export function entryAutoConnectState(entry: unknown): "present" | "missing" | "unsupported" {
  let present = false;

  for (const arg of argsOf(entry)) {
    if (typeof arg === "string" && CONFLICTING_SHORT.has(arg)) return "unsupported";
    const flag = parseFlag(arg);
    if (!flag) continue;

    if (flag.name === "noautoconnect") return "unsupported";
    if (flag.name === "autoconnect") {
      if (flag.value === "false") return "unsupported";
      present = true;
      continue;
    }
    // An explicitly disabled category is not a conflict — it is off.
    if (CONFLICTING.has(flag.name) && flag.value !== "false") return "unsupported";
  }

  return present ? "present" : "missing";
}

/** Append the flag, unless it is already there in some spelling. */
export function addAutoConnect(entry: any): void {
  if (entryAutoConnectState(entry) === "present") return;
  entry.args = [...argsOf(entry), CANONICAL_FLAG];
}

/**
 * Drop the flag and nothing else.
 *
 * An explicit `--no-auto-connect` is left standing: it is the user's own opt-out,
 * and removing it would silently restore the default rather than undo our write.
 */
export function removeAutoConnect(entry: any): void {
  if (!Array.isArray(entry?.args)) return;
  entry.args = entry.args.filter((arg: unknown) => {
    const flag = typeof arg === "string" ? parseFlag(arg) : null;
    return flag?.name !== "autoconnect";
  });
}
