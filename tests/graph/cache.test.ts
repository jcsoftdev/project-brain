/**
 * `serve` is long-lived and resolves OTHER projects' structural graphs on
 * demand, one open SQLite handle each. The original Map that held them had
 * neither a bound nor a close path, so every project a session ever touched
 * kept its handle for the process lifetime — the same failure mode
 * LanceDbStore already guards against with TABLE_CACHE_MAX.
 *
 * GraphCache is that guard, extracted so the eviction and teardown rules are
 * assertable without opening real databases.
 */
import { describe, it, expect } from "bun:test";
import { GraphCache } from "../../src/graph/cache.js";

/** Minimal stand-in for GraphStore: records whether close() ran. */
function fake(name: string) {
  return { name, closed: 0, close() { this.closed++; } };
}

describe("GraphCache", () => {
  it("returns a cached entry instead of reopening", () => {
    const cache = new GraphCache(4);
    const a = fake("a");
    cache.set("a", a);
    expect(cache.get("a")).toBe(a);
  });

  it("misses on an unknown key", () => {
    expect(new GraphCache(4).get("nope")).toBeUndefined();
  });

  it("closes the evicted entry when it exceeds the bound", () => {
    const cache = new GraphCache(2);
    const a = fake("a"), b = fake("b"), c = fake("c");
    cache.set("a", a);
    cache.set("b", b);
    cache.set("c", c);

    expect(cache.size).toBe(2);
    // Evicting without closing is the actual leak — the handle would outlive
    // every reference to it with no way left to release it.
    expect(a.closed, "evicted entry was dropped without closing its handle").toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(b);
    expect(cache.get("c")).toBe(c);
  });

  it("evicts least-RECENTLY-USED, not least-recently-inserted", () => {
    const cache = new GraphCache(2);
    const a = fake("a"), b = fake("b"), c = fake("c");
    cache.set("a", a);
    cache.set("b", b);
    cache.get("a");        // 'a' is now the most recently used
    cache.set("c", c);     // ...so 'b' must be the one to go

    expect(b.closed, "evicted the wrong entry — insertion order, not use order").toBe(1);
    expect(a.closed).toBe(0);
    expect(cache.get("a")).toBe(a);
  });

  it("does not close an entry that is merely refreshed under the same key", () => {
    const cache = new GraphCache(2);
    const a = fake("a");
    cache.set("a", a);
    cache.set("a", a);
    expect(a.closed, "closed a handle that is still the cached value").toBe(0);
    expect(cache.size).toBe(1);
  });

  it("closes a REPLACED entry when the same key gets a different handle", () => {
    const cache = new GraphCache(2);
    const first = fake("first"), second = fake("second");
    cache.set("k", first);
    cache.set("k", second);
    expect(first.closed, "replaced handle leaked — nothing references it anymore").toBe(1);
    expect(cache.get("k")).toBe(second);
  });

  it("close() releases every entry and empties the cache", () => {
    const cache = new GraphCache(8);
    const a = fake("a"), b = fake("b");
    cache.set("a", a);
    cache.set("b", b);
    cache.close();

    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(cache.size).toBe(0);
  });

  /** One bad handle must not strand the rest — shutdown gets one attempt. */
  it("keeps closing after an entry throws", () => {
    const cache = new GraphCache(8);
    const bad = { close() { throw new Error("already closed"); } };
    const good = fake("good");
    cache.set("bad", bad);
    cache.set("good", good);

    expect(() => cache.close()).not.toThrow();
    expect(good.closed, "a throwing handle aborted teardown of the others").toBe(1);
  });

  it("is idempotent — a second close() does not re-close entries", () => {
    const cache = new GraphCache(8);
    const a = fake("a");
    cache.set("a", a);
    cache.close();
    cache.close();
    expect(a.closed).toBe(1);
  });
});
