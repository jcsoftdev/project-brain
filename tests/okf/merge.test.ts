import { describe, it, expect } from "bun:test";
import type { OkfDocument } from "../../src/okf/types.js";

/**
 * The exporter regenerates every concept on every sync, so `mergeDocument` is
 * what stops that from being destructive. It enforces split ownership:
 *
 *   brain-owned  — type, title, resource, sources, generated  (always rewritten)
 *   human-owned  — description, tags, status, verified, stale_after (never clobbered)
 *   body         — derived content inside the managed block, curated prose outside
 *
 * And it gates `generated.at` on content: an unchanged derived block keeps its
 * old timestamp, otherwise every sync would dirty the whole bundle in git.
 */
const NOW = "2026-07-29T12:00:00Z";
const EARLIER = "2026-07-01T08:00:00Z";
const BY = "project-brain/0.15.0";

function generated(overrides: Partial<OkfDocument["frontmatter"]> = {}, body = "derived"): OkfDocument {
  return {
    frontmatter: { type: "Symbol", title: "handleAdr", resource: "/src/tools/adr.ts", generated: { by: BY, at: NOW }, ...overrides },
    body,
  };
}

describe("mergeDocument", () => {
  describe("with no existing document", () => {
    it("returns the generated document wrapped in a managed block", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const merged = mergeDocument(generated(), null, { now: NOW });

      expect(merged.frontmatter.type).toBe("Symbol");
      expect(merged.body).toBe("<!-- project-brain:start -->\nderived\n<!-- project-brain:end -->");
      expect(merged.frontmatter.generated).toEqual({ by: BY, at: NOW });
    });

    it("seeds the curated stub above the managed block when one is provided", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const merged = mergeDocument(generated(), null, { now: NOW, curatedStub: "# Why\n\n_TODO_" });

      expect(merged.body).toBe(
        ["# Why", "", "_TODO_", "", "<!-- project-brain:start -->", "derived", "<!-- project-brain:end -->"].join("\n")
      );
    });
  });

  describe("frontmatter ownership", () => {
    it("overwrites brain-owned fields with the freshly derived values", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol", title: "stale name", resource: "/old/path.ts" },
        body: "<!-- project-brain:start -->\nold\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.title).toBe("handleAdr");
      expect(merged.frontmatter.resource).toBe("/src/tools/adr.ts");
    });

    it("preserves human-owned fields that the generator does not know about", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: {
          type: "Symbol",
          description: "Written by a human.",
          tags: ["adr", "policy"],
          status: "stable",
          stale_after: "2026-12-31",
          verified: [{ by: "human:jcsoftdev", at: EARLIER }],
        },
        body: "<!-- project-brain:start -->\nderived\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.description).toBe("Written by a human.");
      expect(merged.frontmatter.tags).toEqual(["adr", "policy"]);
      expect(merged.frontmatter.status).toBe("stable");
      expect(merged.frontmatter.stale_after).toBe("2026-12-31");
      expect(merged.frontmatter.verified).toEqual([{ by: "human:jcsoftdev", at: EARLIER }]);
    });

    it("falls back to the generated value when the human never set the field", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = { frontmatter: { type: "Symbol" }, body: "" };

      const merged = mergeDocument(generated({ description: "Derived summary." }), existing, { now: NOW });

      expect(merged.frontmatter.description).toBe("Derived summary.");
    });

    it("keeps unrecognized keys the human added", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = { frontmatter: { type: "Symbol", owner_team: "platform" }, body: "" };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.owner_team).toBe("platform");
    });

    it("retains a human attestation even after the derived content changed (§11 surface, don't drop)", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol", verified: [{ by: "human:jcsoftdev", at: EARLIER }] },
        body: "<!-- project-brain:start -->\nOLD derived\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated({}, "NEW derived"), existing, { now: NOW });

      expect(merged.frontmatter.verified).toEqual([{ by: "human:jcsoftdev", at: EARLIER }]);
    });
  });

  describe("body ownership", () => {
    it("preserves curated prose outside the managed block", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol" },
        body: ["# Why", "ADRs are append-only.", "<!-- project-brain:start -->", "old", "<!-- project-brain:end -->"].join("\n"),
      };

      const merged = mergeDocument(generated({}, "new"), existing, { now: NOW });

      expect(merged.body).toBe(
        ["# Why", "ADRs are append-only.", "<!-- project-brain:start -->", "new", "<!-- project-brain:end -->"].join("\n")
      );
    });

    it("appends a managed block to a document a human wrote without one", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = { frontmatter: { type: "Symbol" }, body: "# Why\nHand written." };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.body).toBe(
        ["# Why", "Hand written.", "", "<!-- project-brain:start -->", "derived", "<!-- project-brain:end -->"].join("\n")
      );
    });
  });

  describe("generated.at content gate", () => {
    it("keeps the previous timestamp when nothing derived changed", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol", title: "handleAdr", resource: "/src/tools/adr.ts", generated: { by: BY, at: EARLIER } },
        body: "<!-- project-brain:start -->\nderived\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.generated).toEqual({ by: BY, at: EARLIER });
    });

    it("bumps the timestamp when the derived body changed", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol", title: "handleAdr", resource: "/src/tools/adr.ts", generated: { by: BY, at: EARLIER } },
        body: "<!-- project-brain:start -->\nOLD derived\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.generated).toEqual({ by: BY, at: NOW });
    });

    it("bumps the timestamp when a brain-owned frontmatter field changed", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: { type: "Symbol", title: "handleAdr", resource: "/old/path.ts", generated: { by: BY, at: EARLIER } },
        body: "<!-- project-brain:start -->\nderived\n<!-- project-brain:end -->",
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.generated?.at).toBe(NOW);
    });

    it("does NOT bump the timestamp when only curated content changed", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");

      const existing: OkfDocument = {
        frontmatter: {
          type: "Symbol",
          title: "handleAdr",
          resource: "/src/tools/adr.ts",
          description: "A human edited this.",
          generated: { by: BY, at: EARLIER },
        },
        body: ["# Why", "Freshly written prose.", "<!-- project-brain:start -->", "derived", "<!-- project-brain:end -->"].join("\n"),
      };

      const merged = mergeDocument(generated(), existing, { now: NOW });

      expect(merged.frontmatter.generated?.at).toBe(EARLIER);
    });

    it("is byte-stable across repeated merges — the anti-churn guarantee", async () => {
      const { mergeDocument } = await import("../../src/okf/merge.js");
      const { renderDocument } = await import("../../src/okf/render.js");
      const { parseDocument } = await import("../../src/okf/frontmatter.js");

      const first = renderDocument(mergeDocument(generated(), null, { now: EARLIER }));
      const second = renderDocument(mergeDocument(generated(), parseDocument(first), { now: NOW }));

      expect(second).toBe(first);
    });
  });
});
