// src/parser/pool.ts
// Bounded worker-pool parallel WASM parse — the "Future (phase 2)" deferred
// in docs/superpowers/specs/2026-06-16-structural-layer-design.md §12. Each
// worker (src/parser/worker.ts) owns its own memory-bounded WasmParser;
// nothing is shared across threads. Spawned per reindex run, terminated
// after — never resident in the long-lived `serve` process.
import type { SymbolInput } from "../graph/store.js";
import type { ParseRequest, ParseResponse } from "./worker.js";

export interface ParseJob {
  path: string;
  content: string;
  ext: string;
}

export interface ParseResult {
  path: string;
  langId: string;
  symbols: SymbolInput[];
  error?: string;
}

/**
 * Below this file count, worker-thread startup overhead outweighs the
 * parallelism gain — callers should use the existing sequential WasmParser
 * path instead of constructing a ParserPool.
 */
export const POOL_MIN_FILES = 24;

interface QueuedJob {
  job: ParseJob;
  resolve: (r: ParseResult) => void;
}

export class ParserPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: QueuedJob[] = [];
  private nextId = 0;
  private pending = new Map<number, { resolve: (r: ParseResult) => void; path: string }>();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
      worker.onmessage = (event: MessageEvent<ParseResponse>) => {
        const res = event.data;
        const entry = this.pending.get(res.id);
        if (!entry) return;
        this.pending.delete(res.id);
        if ("error" in res) {
          entry.resolve({ path: res.path, langId: "", symbols: [], error: res.error });
        } else {
          entry.resolve({ path: res.path, langId: res.langId, symbols: res.symbols });
        }
        this.idle.push(worker);
        this.drainQueue();
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  private drainQueue(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const { job, resolve } = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { resolve, path: job.path });
      const req: ParseRequest = { id, path: job.path, content: job.content, ext: job.ext };
      worker.postMessage(req);
    }
  }

  parseOne(job: ParseJob): Promise<ParseResult> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.drainQueue();
    });
  }

  async parseMany(jobs: ParseJob[]): Promise<ParseResult[]> {
    return Promise.all(jobs.map((job) => this.parseOne(job)));
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
