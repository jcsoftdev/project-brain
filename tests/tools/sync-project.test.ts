import { describe, it, expect } from "bun:test";
import { handleSyncProject } from "../../src/tools/sync-project.js";

describe("sync_project", () => {
  it("errors without projectRoot", async () => {
    const r = await handleSyncProject({ project: "p" }, {} as any, undefined);
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe("PROJECT_ROOT_UNAVAILABLE");
  });

  it("runs an injected runSync and forwards progress when a token exists", async () => {
    const notifications: any[] = [];
    const extra = {
      _meta: { progressToken: "tok-1" },
      sendNotification: async (n: any) => { notifications.push(n); },
    } as any;
    const fakeRunSync = async (opts: any) => {
      opts.onProgress?.({ phase: "embedding", current: 3, total: 10 });
      return { ingested: 2, skipped: 1, deleted: 0, scanned: 3, embedFailed: 0 };
    };
    const deps = { projectRoot: "/tmp/x", store: {}, embeddings: {}, graph: {}, embeddingsFor: async () => ({}) } as any;
    const r = await handleSyncProject({ project: "p" }, deps, extra, fakeRunSync as any);
    expect((r.structuredContent as any).ingested).toBe(2);
    expect(notifications.length).toBe(1);
    expect(notifications[0].method).toBe("notifications/progress");
    expect(notifications[0].params).toMatchObject({ progressToken: "tok-1", progress: 3, total: 10 });
  });

  it("sends no notifications without a progressToken", async () => {
    const notifications: any[] = [];
    const extra = { sendNotification: async (n: any) => { notifications.push(n); } } as any;
    const fakeRunSync = async (opts: any) => { opts.onProgress?.({ phase: "reading", current: 1, total: 2 }); return { ingested: 0, skipped: 2, deleted: 0, scanned: 2, embedFailed: 0 }; };
    const deps = { projectRoot: "/tmp/x", store: {}, embeddings: {}, graph: {}, embeddingsFor: async () => ({}) } as any;
    await handleSyncProject({ project: "p" }, deps, extra, fakeRunSync as any);
    expect(notifications.length).toBe(0);
  });
});
