import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOkfCandidates } from "../../src/tools/okf-candidates.js";
import type { ToolDeps } from "../../src/types.js";

const SEP = "\x01";

function metaOutput(commits: { hash: string; subject: string; body: string }[]): string {
  return commits.map((c) => `${c.hash}${SEP}${c.subject}${SEP}${c.body}`).join("\0") + "\0";
}

function numstatOutput(records: { hash: string; files: { path: string; added: number; deleted: number }[] }[]): string {
  return records
    .map((r) => `${r.hash}\n${r.files.map((f) => `${f.added}\t${f.deleted}\t${f.path}`).join("\0")}\0`)
    .join("\0");
}

function fakeSpawn(byArgs: (args: string[]) => { stdout: string; status: number }) {
  return (_cmd: string, args: string[]) => {
    const { stdout, status } = byArgs(args);
    return { stdout, stderr: "", status, signal: null, output: [], pid: 0 } as any;
  };
}

describe("handleOkfCandidates", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-tool-cand-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export function alpha() {}\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const emptyGraph = { pageRank: () => [], findCallers: () => [], impact: () => [] } as any;

  function deps(): ToolDeps {
    return { graph: emptyGraph, projectId: "p", projectRoot: root } as unknown as ToolDeps;
  }

  const spawn: any = fakeSpawn((args) =>
    args.includes("--numstat")
      ? { stdout: numstatOutput([{ hash: "h1", files: [{ path: "src/a.ts", added: 5, deleted: 0 }] }]), status: 0 }
      : { stdout: metaOutput([{ hash: "h1", subject: "fix: it", body: "story" }]), status: 0 }
  );

  it("returns ranked candidates in structuredContent, heuristic when no token resolves", async () => {
    const result = await handleOkfCandidates({}, deps(), { spawn, resolveToken: async () => null });
    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as any;
    expect(body.heuristic).toBe(true);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].hash).toBe("h1");
  });

  it("errors with PROJECT_MISMATCH rather than silently reading another project's repo", async () => {
    const result = await handleOkfCandidates({ project: "other" }, deps(), { spawn, resolveToken: async () => null });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("PROJECT_MISMATCH");
  });

  it("errors with GRAPH_UNAVAILABLE when the server has no structural graph", async () => {
    const result = await handleOkfCandidates({}, { projectId: "p", projectRoot: root } as unknown as ToolDeps, {
      spawn,
      resolveToken: async () => null,
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).code).toBe("GRAPH_UNAVAILABLE");
  });
});
