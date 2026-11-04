import { describe, it, expect } from "bun:test";
import { decidePrune, parseDuration, parsePages, recordSeen, stalePages } from "../../src/browser/pages.js";

const LIST = [
  "## Pages",
  "157: Pulzifi (https://x.test/a) [selected]",
  "158: Inbox (90) - a@b.c ... (https://mail.test/)",
  "159: Old tab (https://old.test/)",
  "189: Newest (https://new.test/)",
].join("\n");

describe("list_pages output", () => {
  it("parses id, label and the selected marker, skipping headings", () => {
    const pages = parsePages(LIST);
    expect(pages.map((p) => p.id)).toEqual([157, 158, 159, 189]);
    expect(pages[0]).toMatchObject({ selected: true, label: "Pulzifi (https://x.test/a)" });
    expect(pages[1]!.selected).toBe(false);
  });
});

describe("which pages are worth asking about", () => {
  const H = 3_600_000;
  const pages = parsePages(LIST);
  const state = { "9:157": 0, "9:158": 0, "9:159": 5 * H, "9:189": 9 * H };

  it("never lists the selected page or the most recently first-seen one", () => {
    const stale = stalePages(pages, state, 9, 10 * H, 1 * H).map((p) => p.id);
    expect(stale).toEqual([158, 159]);
  });

  it("respects the age threshold, and counts an unseen page as seen just now", () => {
    expect(stalePages(pages, state, 9, 10 * H, 8 * H).map((p) => p.id)).toEqual([158]);
    expect(stalePages(pages, {}, 9, 10 * H, 1 * H)).toEqual([]);
  });

  it("keeps first-seen times, forgets closed pages, and starts clean for a restarted server", () => {
    const next = recordSeen({ "9:157": 1, "9:999": 2 }, 9, pages, 100);
    expect(next["9:157"]).toBe(1);
    expect(next["9:158"]).toBe(100);
    expect(next["9:999"]).toBeUndefined();
    expect(recordSeen(next, 10, pages, 200)["10:157"]).toBe(200);
  });
});

describe("closing pages", () => {
  const stale = [{ id: 1, label: "x", selected: false }];

  it("is a dry run until confirmed", () => {
    expect(decidePrune("headless-profile", stale, false).kind).toBe("dry-run");
    expect(decidePrune("headless-profile", stale, true)).toEqual({ kind: "close", pages: stale });
  });

  it("is refused on a server that may be showing the owner's own tabs, even when confirmed", () => {
    expect(decidePrune("autoConnect", stale, true).kind).toBe("refuse");
    expect(decidePrune("foreign", stale, true).kind).toBe("refuse");
  });

  it("parses durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});
