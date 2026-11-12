import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EmbeddingClient } from "../types.js";
import { DATA_DIR } from "../constants.js";
import { OllamaEmbeddingClient } from "./ollama.js";

export type EmbedLane = "interactive" | "bulk";

export const INTERACTIVE_PORT = 11435;
export const DEFAULT_INTERACTIVE_HOST = `http://127.0.0.1:${INTERACTIVE_PORT}`;

export const INTERACTIVE_HOST_ENV = "BRAIN_OLLAMA_INTERACTIVE_HOST";

export const INTERACTIVE_TIMEOUT_MS = 400;

export const DEAD_LANE_TTL_MS = 60_000;

const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);

export function ollamaConfigPath(dataDir: string): string {
  return join(dataDir, "ollama.json");
}

function configuredHost(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  try {
    const value = (JSON.parse(readFileSync(configPath, "utf-8")) as { interactiveHost?: unknown }).interactiveHost;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveInteractiveHost(
  opts: { env?: Record<string, string | undefined>; configPath?: string } = {}
): string | null {
  const env = opts.env ?? process.env;
  const raw = env[INTERACTIVE_HOST_ENV]?.trim() || configuredHost(opts.configPath)?.trim() || DEFAULT_INTERACTIVE_HOST;
  return OFF_VALUES.has(raw.toLowerCase()) ? null : raw.replace(/\/+$/, "");
}

export interface DeadLaneMemo {
  isDead(): boolean;
  markDead(): void;
}

export function fileDeadLaneMemo(
  host: string,
  opts: { dir?: string; ttlMs?: number; now?: () => number } = {}
): DeadLaneMemo {
  const file = join(opts.dir ?? tmpdir(), `project-brain-lane-dead-${host.replace(/[^a-z0-9]+/gi, "_")}`);
  const ttl = opts.ttlMs ?? DEAD_LANE_TTL_MS;
  const now = opts.now ?? Date.now;
  return {
    isDead() {
      try {
        const since = Number(readFileSync(file, "utf-8"));
        return Number.isFinite(since) && now() - since < ttl;
      } catch {
        return false;
      }
    },
    markDead() {
      try {
        writeFileSync(file, String(now()));
      } catch {
        return;
      }
    },
  };
}

export class InteractiveLaneClient implements EmbeddingClient {
  readonly model?: string;
  readonly dim: number;

  constructor(
    private readonly interactive: EmbeddingClient,
    private readonly fallback: EmbeddingClient,
    private readonly memo: DeadLaneMemo
  ) {
    this.model = fallback.model;
    this.dim = fallback.dim;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.memo.isDead()) {
      const vectors = await this.interactive.embed(texts).catch(() => null);
      if (vectors) return vectors;
      this.memo.markDead();
    }
    return this.fallback.embed(texts);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.interactive.isAvailable()) || this.fallback.isAvailable();
  }

  reset(): void {
    this.interactive.reset?.();
    this.fallback.reset?.();
  }
}

export interface LaneOptions {
  lane?: EmbedLane;
  
  interactiveHost?: string | null;
  memo?: DeadLaneMemo;
}

export function withLane(client: EmbeddingClient, opts: LaneOptions = {}): EmbeddingClient {
  if (opts.lane !== "interactive" || !client.model || client.model === "none") return client;
  const host =
    opts.interactiveHost !== undefined
      ? opts.interactiveHost
      : resolveInteractiveHost({ configPath: defaultConfigPath() });
  if (!host) return client;
  const interactive = new OllamaEmbeddingClient(host, undefined, client.model, client.dim, {
    attempts: 1,
    timeoutMs: INTERACTIVE_TIMEOUT_MS,
    quiet: true,
  });
  return new InteractiveLaneClient(interactive, client, opts.memo ?? fileDeadLaneMemo(host));
}

function defaultConfigPath(): string {
  return ollamaConfigPath(DATA_DIR);
}

export interface InteractiveLaneStatus {
  status: "off" | "up" | "down";
  host?: string;
}

export async function probeInteractiveLane(
  opts: { host?: string | null; fetchImpl?: typeof fetch } = {}
): Promise<InteractiveLaneStatus> {
  const host = opts.host !== undefined ? opts.host : resolveInteractiveHost({ configPath: defaultConfigPath() });
  if (!host) return { status: "off" };
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${host}/api/tags`, { signal: AbortSignal.timeout(1_000) });
    return { status: res.ok ? "up" : "down", host };
  } catch {
    return { status: "down", host };
  }
}
