/**
 * One chrome-devtools MCP server for every session, instead of one per session.
 *
 * A host starts one MCP server PROCESS PER SESSION, eagerly, whether or not the
 * session ever opens a browser. There is no lazy start and no idle unload to
 * turn on: for stdio servers neither exists. So the cost is paid per session,
 * and with `--autoConnect` each of those servers opens its own CDP attachment
 * to the same Chrome — attachments that never release, because the user's own
 * browser outlives every session. Measured on one machine: six servers alive,
 * two of them attached for ~2 days at 1.6 GB and 742 MB of RSS.
 *
 * The way out is not a flag; chrome-devtools-mcp has none for this. It is to
 * stop every session from spawning its own: run ONE server, put an HTTP bridge
 * in front of it, and point each host config at the URL. Sessions then cost a
 * client connection each, and the machine carries one server and one attachment.
 *
 * What this does NOT fix: how large that one server grows. Nothing bounds it —
 * a single attached server was the 1.6 GB one. Collapsing N to 1 is the whole
 * claim; restarting the service between long stretches is still worth doing,
 * and `restartCommand()` is here so the guidance can name it.
 */

/**
 * The bridge, and the constraint that makes it installable.
 *
 * `mcp-proxy` in server mode calls `stdio_client` ONCE at startup and reuses
 * that one session for every client, so all clients share a single child. Its
 * JSON-RPC ids cannot collide either: it proxies at the MCP semantic layer, so
 * each client keeps its own id space and the proxy mints its own toward the
 * child. `supergateway` was the other candidate and is not usable here — its
 * stateless streamable-HTTP mode spawns a child PER REQUEST and never reaps
 * them, which is worse than the problem being solved.
 */
export const BRIDGE_PACKAGE = "mcp-proxy";

/**
 * Pinned below 2 on purpose, and this is not cosmetic: `uv tool install
 * mcp-proxy` on its own resolves the MCP SDK to 2.x, where `request_ctx` no
 * longer exists, and every invocation then dies at import with
 * `ImportError: cannot import name 'request_ctx'`. The tool is installed once
 * and would look simply broken, so the constraint travels with the install.
 */
export const BRIDGE_SDK_CONSTRAINT = "mcp<2";

/** Loopback only. A CDP bridge reachable off-box is a remote-control server. */
export const BRIDGE_HOST = "127.0.0.1";

/**
 * Chosen high and out of the way rather than near 9222: 9222 is what everything
 * else assumes for CDP, and colliding with a browser someone launched by hand
 * is the one failure that would look like the bridge itself being broken.
 */
export const DEFAULT_PORT = 39100;

/** Stable across releases — it names the installed service and its log. */
export const SERVICE_LABEL = "dev.projectbrain.chrome-devtools-shared";

export interface SharedServerSpec {
  /** Where the bridge listens. */
  port: number;
  /** Absolute path to the `mcp-proxy` executable. */
  bridgeBin: string;
  /**
   * The stdio server to put behind the bridge, argv-style — taken verbatim from
   * the host entry being replaced, so whatever flags the user already answered
   * for (including `--autoConnect`) move across untouched.
   */
  command: string[];
  /** Where the service writes stdout and stderr. */
  logPath: string;
  /** `PATH` the service runs with; a login service inherits almost nothing. */
  path: string;
}

/** Which service manager can hold the server open on this platform. */
export function serviceKindFor(platform: string): "launchd" | "systemd" | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/** The bridge's own argv: listen here, and proxy to that. */
export function bridgeArgv(spec: SharedServerSpec): string[] {
  return [
    spec.bridgeBin,
    "--port",
    String(spec.port),
    "--host",
    BRIDGE_HOST,
    "--",
    ...spec.command,
  ];
}

/** Arguments that install the bridge with its SDK pinned. See the constant. */
export function bridgeInstallArgs(): string[] {
  return ["tool", "install", BRIDGE_PACKAGE, "--with", BRIDGE_SDK_CONSTRAINT, "--force"];
}

export function sharedUrl(port: number): string {
  return `http://${BRIDGE_HOST}:${port}/mcp`;
}

/** What a host entry becomes once the session stops spawning its own server. */
export function sharedEntry(port: number): { type: "http"; url: string } {
  return { type: "http", url: sharedUrl(port) };
}

/**
 * Whether an entry already points at this bridge.
 *
 * Matched on the URL rather than the key, for the same reason
 * `isChromeDevtoolsEntry` matches on the command: the key is the user's label.
 */
export function isSharedEntry(entry: unknown, port: number): boolean {
  const e = entry as { url?: unknown };
  return typeof e?.url === "string" && e.url === sharedUrl(port);
}

/** XML has five of these and a plist that escapes four is a plist that corrupts. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function launchdPlist(spec: SharedServerSpec): string {
  const args = bridgeArgv(spec)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");

  // KeepAlive, because the whole point is that it outlives any one session:
  // a bridge that dies quietly turns every host's browser tools into errors
  // with no obvious cause.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(spec: SharedServerSpec): string {
  // systemd splits argv on whitespace, so an argument containing a space must
  // be quoted or it silently becomes two arguments.
  const exec = bridgeArgv(spec)
    .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");

  return `[Unit]
Description=Shared chrome-devtools MCP server (project-brain)

[Service]
ExecStart=${exec}
Environment=PATH=${spec.path}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Per-shell paths that a login service must not be pointed at.
 *
 * Node version managers put the active `node`/`npx` behind a directory scoped
 * to the shell that activated it — fnm mints `fnm_multishells/<pid>_<ts>`, and
 * it is gone once that shell exits. Resolving the command at setup time
 * therefore captures a path that works right now and breaks at the next login,
 * which presents as a service that "worked yesterday" with nothing in the log
 * but a missing file. Cheaper to say so while the user is still here.
 */
const EPHEMERAL_PATH_SEGMENTS = ["fnm_multishells", "/nvm/versions/", "/.nvm/"];

/** A warning naming the stable path to use instead, or null when it is fine. */
export function ephemeralPathWarning(bin: string): string | null {
  const hit = EPHEMERAL_PATH_SEGMENTS.find((seg) => bin.includes(seg));
  if (!hit) return null;

  return (
    `${bin} lives under "${hit}", which a node version manager recreates per shell — ` +
    `the service would start now and fail to find it after the next login. Point the ` +
    `entry at a version-stable path (fnm: ~/.local/share/fnm/aliases/default/bin, ` +
    `nvm: ~/.nvm/alias/default) before installing the shared server.`
  );
}

/** What to tell someone whose shared server has been up long enough to bloat. */
export function restartCommand(kind: "launchd" | "systemd"): string {
  return kind === "launchd"
    ? `launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`
    : `systemctl --user restart ${SERVICE_LABEL}`;
}
