import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingClient } from "../types.js";
import { DATA_DIR, OLLAMA_HOST } from "../constants.js";
import { resolveLauncher } from "../server/supervisor.js";
import { OllamaEmbeddingClient, embedRequestBody } from "./ollama.js";

export type EmbedLane = "interactive" | "bulk";

export const INTERACTIVE_PORT = 11435;
export const DEFAULT_INTERACTIVE_HOST = `http://127.0.0.1:${INTERACTIVE_PORT}`;

export const INTERACTIVE_HOST_ENV = "BRAIN_OLLAMA_INTERACTIVE_HOST";

export const INTERACTIVE_TIMEOUT_MS = 400;

export const LANE_VERDICT_TTL_MS = {
  ok: 15 * 60_000,
  mismatch: 15 * 60_000,
  dead: 60_000,
  pending: 60_000,
} as const;

export type LaneState = keyof typeof LANE_VERDICT_TTL_MS;

export interface LaneVerdict {
  state: LaneState;
  at: number;
  reason?: string;
}

export const LANE_PROBE_TEXT = "project-brain interactive lane identity probe";

const VERIFY_TIMEOUT_MS = 120_000;

const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);

export function ollamaConfigPath(dataDir: string = DATA_DIR): string {
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
  const raw = env[INTERACTIVE_HOST_ENV]?.trim() || configuredHost(opts.configPath)?.trim();
  if (!raw || OFF_VALUES.has(raw.toLowerCase())) return null;
  return raw.replace(/\/+$/, "");
}

export interface LaneMemo {
  read(): LaneVerdict | null;
  write(state: LaneState, reason?: string): void;
}

const slug = (value: string) => value.replace(/[^a-z0-9]+/gi, "_");

export function fileLaneMemo(
  host: string,
  model: string,
  opts: { dir?: string; now?: () => number } = {}
): LaneMemo {
  const dir = opts.dir ?? join(DATA_DIR, "lane");
  const file = join(dir, `${slug(host)}__${slug(model)}.json`);
  const now = opts.now ?? Date.now;
  return {
    read() {
      try {
        const verdict = JSON.parse(readFileSync(file, "utf-8")) as LaneVerdict;
        const ttl = LANE_VERDICT_TTL_MS[verdict.state];
        const age = now() - verdict.at;
        return ttl !== undefined && age >= 0 && age < ttl ? verdict : null;
      } catch {
        return null;
      }
    },
    write(state, reason) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ state, at: now(), ...(reason ? { reason } : {}) }));
      } catch {
        return;
      }
    },
  };
}

export interface VerifyLaneOptions {
  host: string;
  fallbackHost: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Verified = { state: "ok" | "mismatch" | "dead"; reason?: string };

async function getJson<T>(fetchImpl: typeof fetch, url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

function modelDigest(tags: { models?: Array<{ name?: string; digest?: string }> }, model: string): string | undefined {
  return tags.models?.find((m) => m.name === model || m.name === `${model}:latest`)?.digest;
}

function sameVector(a: number[] | undefined, b: number[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function verifyLane(opts: VerifyLaneOptions): Promise<Verified> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const both = <T>(path: string, init?: RequestInit) =>
    Promise.all([
      getJson<T>(fetchImpl, `${opts.host}${path}`, timeoutMs, init),
      getJson<T>(fetchImpl, `${opts.fallbackHost}${path}`, timeoutMs, init),
    ]);

  try {
    const [laneVersion, defaultVersion] = await both<{ version?: string }>("/api/version");
    if (laneVersion.version !== defaultVersion.version) {
      return { state: "mismatch", reason: `ollama ${laneVersion.version} on the lane, ${defaultVersion.version} on the default` };
    }

    const [laneTags, defaultTags] = await both<{ models?: Array<{ name?: string; digest?: string }> }>("/api/tags");
    const laneDigest = modelDigest(laneTags, opts.model);
    const defaultDigest = modelDigest(defaultTags, opts.model);
    if (!laneDigest || laneDigest !== defaultDigest) {
      return { state: "mismatch", reason: laneDigest ? `${opts.model} digest differs` : `${opts.model} is not installed on the lane` };
    }

    const [laneProbe, defaultProbe] = await both<{ embeddings?: number[][] }>("/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(embedRequestBody(opts.model, [LANE_PROBE_TEXT])),
    });
    if (!sameVector(laneProbe.embeddings?.[0], defaultProbe.embeddings?.[0])) {
      return { state: "mismatch", reason: "probe embedding differs (runner settings such as flash attention or KV cache type)" };
    }
    return { state: "ok" };
  } catch (err) {
    return { state: "dead", reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyAndRecord(opts: VerifyLaneOptions & { memo?: LaneMemo }): Promise<Verified> {
  const verdict = await verifyLane(opts);
  (opts.memo ?? fileLaneMemo(opts.host, opts.model)).write(verdict.state, verdict.reason);
  return verdict;
}

export type LaneVerifier = (host: string, fallbackHost: string, model: string) => void;

export const spawnLaneVerify: LaneVerifier = (host, fallbackHost, model) => {
  try {
    Bun.spawn([...resolveLauncher().argv, "lane-verify", host, fallbackHost, model], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    return;
  }
};

export class InteractiveLaneClient implements EmbeddingClient {
  readonly model?: string;
  readonly dim: number;

  constructor(
    private readonly interactive: EmbeddingClient,
    private readonly fallback: EmbeddingClient,
    private readonly memo: LaneMemo,
    private readonly verify: () => void = () => {}
  ) {
    this.model = fallback.model;
    this.dim = fallback.dim;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (texts.length !== 1) return this.fallback.embed(texts);

    const verdict = this.memo.read();
    if (verdict?.state === "ok") {
      const vectors = await this.interactive.embed(texts).catch(() => null);
      if (vectors) return vectors;
      this.memo.write("dead", "no answer within the interactive budget");
    } else if (!verdict) {
      this.memo.write("pending");
      this.verify();
    }
    return this.fallback.embed(texts);
  }

  async isAvailable(): Promise<boolean> {
    return this.fallback.isAvailable();
  }

  reset(): void {
    this.interactive.reset?.();
    this.fallback.reset?.();
  }
}

export interface LaneOptions {
  lane?: EmbedLane;
  interactiveHost?: string | null;
  fallbackHost?: string;
  memo?: LaneMemo;
  verify?: LaneVerifier;
}

export function withLane(client: EmbeddingClient, opts: LaneOptions = {}): EmbeddingClient {
  if (opts.lane !== "interactive" || !client.model || client.model === "none") return client;
  const host =
    opts.interactiveHost !== undefined ? opts.interactiveHost : resolveInteractiveHost({ configPath: ollamaConfigPath() });
  if (!host) return client;
  const model = client.model;
  const fallbackHost = opts.fallbackHost ?? OLLAMA_HOST;
  const interactive = new OllamaEmbeddingClient(host, undefined, model, client.dim, {
    attempts: 1,
    timeoutMs: INTERACTIVE_TIMEOUT_MS,
    quiet: true,
  });
  const verify = opts.verify ?? spawnLaneVerify;
  return new InteractiveLaneClient(interactive, client, opts.memo ?? fileLaneMemo(host, model), () =>
    verify(host, fallbackHost, model)
  );
}

export interface InteractiveLaneStatus {
  status: "off" | "up" | "down" | "mismatch";
  host?: string;
  reason?: string;
}

export async function probeInteractiveLane(opts: {
  model: string;
  host?: string | null;
  fallbackHost?: string;
  fetchImpl?: typeof fetch;
  memo?: LaneMemo;
}): Promise<InteractiveLaneStatus> {
  const host = opts.host !== undefined ? opts.host : resolveInteractiveHost({ configPath: ollamaConfigPath() });
  if (!host) return { status: "off" };
  const verdict = await verifyAndRecord({
    host,
    fallbackHost: opts.fallbackHost ?? OLLAMA_HOST,
    model: opts.model,
    fetchImpl: opts.fetchImpl,
    memo: opts.memo,
  });
  const status = verdict.state === "ok" ? "up" : verdict.state === "dead" ? "down" : "mismatch";
  return { status, host, ...(verdict.reason ? { reason: verdict.reason } : {}) };
}
