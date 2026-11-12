import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INTERACTIVE_PORT } from "../embeddings/lane.js";

export const OLLAMA_INTERACTIVE_LABEL = "dev.projectbrain.ollama-interactive";

export type ServiceKind = "launchd" | "systemd";

export const INTERACTIVE_MAX_LOADED_MODELS = 2;

export interface InteractiveOllamaSpec {
  ollamaBin: string;
  modelsDir: string;
  logPath: string;
  runnerEnv?: Record<string, string>;
}

export const RUNNER_ENV_KEYS = ["OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_LLM_LIBRARY", "OLLAMA_MODELS"] as const;

export const SYSTEM_UNIT_DIR = join("/", "etc", "systemd", "system");

export const SYSTEM_INSTALL_MODELS_DIR = join("/", "usr", "share", "ollama", ".ollama", "models");

export function defaultOllamaServiceFiles(home: string = homedir()): string[] {
  return [
    join(home, "Library", "LaunchAgents", "sh.brew.ollama.plist"),
    join(home, "Library", "LaunchAgents", "homebrew.mxcl.ollama.plist"),
    join(home, ".config", "systemd", "user", "ollama.service"),
    join(SYSTEM_UNIT_DIR, "ollama.service"),
  ];
}

function unxml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function systemdAssignments(line: string): Array<[string, string]> {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)]
    .map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!))
    .flatMap((token) => {
      const at = token.indexOf("=");
      return at > 0 ? [[token.slice(0, at), token.slice(at + 1)] as [string, string]] : [];
    });
}

export function serviceDefinitionEnv(text: string): Record<string, string> {
  const fromPlist = [...text.matchAll(/<key>(OLLAMA_[A-Z_]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map(
    (m) => [m[1]!, unxml(m[2]!)] as [string, string]
  );
  const fromUnit = [...text.matchAll(/^Environment=(.*)$/gm)].flatMap((m) => systemdAssignments(m[1]!));
  return Object.fromEntries([...fromPlist, ...fromUnit].filter(([key]) => key.startsWith("OLLAMA_")));
}

export interface ServiceFileReader {
  readText(path: string): string | null;
  listDir(path: string): string[];
}

function pickRunnerEnv(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(RUNNER_ENV_KEYS.flatMap((key) => (source[key] ? [[key, source[key]!]] : [])));
}

function definitionWithDropIns(file: string, text: string, reader: ServiceFileReader): Record<string, string> {
  const dropInDir = `${file}.d`;
  const dropIns = reader
    .listDir(dropInDir)
    .filter((name) => name.endsWith(".conf"))
    .sort()
    .map((name) => reader.readText(join(dropInDir, name)))
    .filter((t): t is string => t !== null);
  return Object.assign({}, serviceDefinitionEnv(text), ...dropIns.map(serviceDefinitionEnv));
}

export function defaultInstanceEnv(
  files: string[],
  reader: ServiceFileReader,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  for (const file of files) {
    const text = reader.readText(file);
    if (text === null) continue;
    const merged = definitionWithDropIns(file, text, reader);
    const isSystemInstall = file.startsWith(SYSTEM_UNIT_DIR);
    return pickRunnerEnv({
      ...merged,
      OLLAMA_MODELS: merged.OLLAMA_MODELS ?? (isSystemInstall ? SYSTEM_INSTALL_MODELS_DIR : undefined),
    });
  }
  return pickRunnerEnv(env);
}

const OLLAMA_BIN_CANDIDATES = [
  "/opt/homebrew/bin/ollama",
  "/usr/local/bin/ollama",
  "/usr/bin/ollama",
  "/Applications/Ollama.app/Contents/Resources/ollama",
];

export function findOllamaBin(
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync
): string | null {
  return which("ollama") ?? OLLAMA_BIN_CANDIDATES.find(exists) ?? null;
}

export function sharedModelsDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.OLLAMA_MODELS?.trim() || join(home, ".ollama", "models");
}

export function interactiveServiceEnv(spec: InteractiveOllamaSpec): Record<string, string> {
  return {
    ...spec.runnerEnv,
    OLLAMA_HOST: `127.0.0.1:${INTERACTIVE_PORT}`,
    OLLAMA_KEEP_ALIVE: "-1",
    OLLAMA_MAX_LOADED_MODELS: String(INTERACTIVE_MAX_LOADED_MODELS),
    OLLAMA_MODELS: spec.modelsDir,
  };
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function interactiveLaunchdPlist(spec: InteractiveOllamaSpec): string {
  const env = Object.entries(interactiveServiceEnv(spec))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OLLAMA_INTERACTIVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.ollamaBin)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function systemdPath(path: string): string {
  return path.replace(/%/g, "%%");
}

export function interactiveSystemdUnit(spec: InteractiveOllamaSpec): string {
  const env = Object.entries(interactiveServiceEnv(spec))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");

  return `[Unit]
Description=Ollama for project-brain prompt-time embeds (port ${INTERACTIVE_PORT})

[Service]
ExecStart=${systemdQuote(spec.ollamaBin)} serve
${env}
StandardOutput=append:${systemdPath(spec.logPath)}
StandardError=append:${systemdPath(spec.logPath)}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function interactiveServiceText(kind: ServiceKind, spec: InteractiveOllamaSpec): string {
  return kind === "launchd" ? interactiveLaunchdPlist(spec) : interactiveSystemdUnit(spec);
}

export function interactiveServiceFile(kind: ServiceKind, dir: string): string {
  return join(dir, `${OLLAMA_INTERACTIVE_LABEL}.${kind === "launchd" ? "plist" : "service"}`);
}

const SYSTEMD_UNIT = `${OLLAMA_INTERACTIVE_LABEL}.service`;

export function stopCommands(kind: ServiceKind, uid: number): string[][] {
  return kind === "launchd"
    ? [["launchctl", "bootout", `gui/${uid}/${OLLAMA_INTERACTIVE_LABEL}`]]
    : [["systemctl", "--user", "stop", SYSTEMD_UNIT]];
}

export function startCommands(kind: ServiceKind, file: string, uid: number): string[][] {
  return kind === "launchd"
    ? [["launchctl", "bootstrap", `gui/${uid}`, file]]
    : [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
      ];
}

export function loadedCheckCommand(kind: ServiceKind, uid: number): string[] {
  return kind === "launchd"
    ? ["launchctl", "print", `gui/${uid}/${OLLAMA_INTERACTIVE_LABEL}`]
    : ["systemctl", "--user", "is-active", "--quiet", SYSTEMD_UNIT];
}

export function uninstallCommands(kind: ServiceKind, uid: number): string[][] {
  return kind === "launchd"
    ? [["launchctl", "bootout", `gui/${uid}/${OLLAMA_INTERACTIVE_LABEL}`]]
    : [
        ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT],
        ["systemctl", "--user", "daemon-reload"],
      ];
}

export async function portAnswers(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}
