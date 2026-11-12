import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { INTERACTIVE_PORT } from "../embeddings/lane.js";

export const OLLAMA_INTERACTIVE_LABEL = "dev.projectbrain.ollama-interactive";

export type ServiceKind = "launchd" | "systemd";

export interface InteractiveOllamaSpec {
  ollamaBin: string;
  modelsDir: string;
  logPath: string;
  runnerEnv?: Record<string, string>;
}

export const RUNNER_ENV_KEYS = ["OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_LLM_LIBRARY", "OLLAMA_MODELS"] as const;

export function defaultOllamaServiceFiles(home: string = homedir()): string[] {
  return [
    join(home, "Library", "LaunchAgents", "sh.brew.ollama.plist"),
    join(home, "Library", "LaunchAgents", "homebrew.mxcl.ollama.plist"),
    join(home, ".config", "systemd", "user", "ollama.service"),
    join("/", "etc", "systemd", "system", "ollama.service"),
  ];
}

export function serviceDefinitionEnv(text: string): Record<string, string> {
  const pairs = [
    ...[...text.matchAll(/<key>(OLLAMA_[A-Z_]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => [m[1]!, m[2]!]),
    ...[...text.matchAll(/^Environment="?(OLLAMA_[A-Z_]+)=([^"\n]*)"?$/gm)].map((m) => [m[1]!, m[2]!]),
  ];
  return Object.fromEntries(pairs);
}

export function defaultInstanceEnv(
  files: string[],
  readText: (path: string) => string | null,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const fromService = files.map(readText).find((text): text is string => text !== null);
  const source: Record<string, string | undefined> = fromService ? serviceDefinitionEnv(fromService) : env;
  return Object.fromEntries(RUNNER_ENV_KEYS.flatMap((key) => (source[key] ? [[key, source[key]!]] : [])));
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
    OLLAMA_MAX_LOADED_MODELS: "1",
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

export function interactiveSystemdUnit(spec: InteractiveOllamaSpec): string {
  const env = Object.entries(interactiveServiceEnv(spec))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");

  return `[Unit]
Description=Ollama for project-brain prompt-time embeds (port ${INTERACTIVE_PORT})

[Service]
ExecStart=${systemdQuote(spec.ollamaBin)} serve
${env}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
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

export function installCommands(kind: ServiceKind, file: string, uid: number): string[][] {
  return kind === "launchd"
    ? [
        ["launchctl", "bootout", `gui/${uid}/${OLLAMA_INTERACTIVE_LABEL}`],
        ["launchctl", "bootstrap", `gui/${uid}`, file],
      ]
    : [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", `${OLLAMA_INTERACTIVE_LABEL}.service`],
        ["systemctl", "--user", "restart", `${OLLAMA_INTERACTIVE_LABEL}.service`],
      ];
}

export function uninstallCommands(kind: ServiceKind, uid: number): string[][] {
  return kind === "launchd"
    ? [["launchctl", "bootout", `gui/${uid}/${OLLAMA_INTERACTIVE_LABEL}`]]
    : [
        ["systemctl", "--user", "disable", "--now", `${OLLAMA_INTERACTIVE_LABEL}.service`],
        ["systemctl", "--user", "daemon-reload"],
      ];
}
