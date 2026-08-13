import { describe, it, expect } from "bun:test";
import {
  MODEL_ROUTING,
  ROUTING_TIERS,
  ROUTING_CONTENT_VERSION,
  DEFAULT_HOST_MODELS,
  renderModelRoutingTable,
  type RoutingTier,
} from "../../src/constants.js";

const TIERS: RoutingTier[] = ["fast", "balanced", "deep"];

describe("MODEL_ROUTING tiers", () => {
  it("describes work by tier, never by a vendor model name", () => {
    for (const rule of MODEL_ROUTING) {
      expect(TIERS).toContain(rule.tier);
      expect(rule).not.toHaveProperty("model");
    }
  });

  it("covers every tier — a tier no rule uses is a tier the reader cannot calibrate", () => {
    const used = new Set(MODEL_ROUTING.map((r) => r.tier));
    for (const tier of TIERS) expect(used).toContain(tier);
  });

  it("states what each tier means, so an unknown host can still be mapped", () => {
    expect(ROUTING_TIERS.map((t) => t.tier)).toEqual(TIERS);
    for (const { meaning } of ROUTING_TIERS) expect(meaning.length).toBeGreaterThan(0);
  });

  it("gives every rule a reason — a routing rule without a why cannot be argued with", () => {
    for (const rule of MODEL_ROUTING) {
      expect(rule.task.length).toBeGreaterThan(0);
      expect(rule.why.length).toBeGreaterThan(0);
    }
  });

  it("carries a content version so a stale written section can be detected", () => {
    expect(ROUTING_CONTENT_VERSION).toBeGreaterThan(0);
  });
});

describe("DEFAULT_HOST_MODELS", () => {
  it("maps all three tiers for every host it knows", () => {
    for (const [host, models] of Object.entries(DEFAULT_HOST_MODELS)) {
      expect(Object.keys(models).sort()).toEqual([...TIERS].sort());
      expect(host.length).toBeGreaterThan(0);
    }
  });

  it("names Claude Code's models, which are verifiable", () => {
    expect(DEFAULT_HOST_MODELS.claude).toEqual({
      fast: "haiku",
      balanced: "sonnet",
      deep: "opus",
    });
  });

  it("uses null rather than a guess where no stable model name exists", () => {
    // opencode ids are provider-scoped (`provider/model-id`) and depend on the
    // user's configured provider — inventing one would ship a broken config.
    expect(DEFAULT_HOST_MODELS.opencode?.balanced).toBeNull();
  });
});

describe("renderModelRoutingTable", () => {
  it("emits a header, a separator and one row per rule", () => {
    const lines = renderModelRoutingTable().trim().split("\n");
    expect(lines.length).toBe(MODEL_ROUTING.length + 2);
    expect(lines[0]).toContain("Tier");
    expect(lines[1]).toMatch(/^\|[\s-|]+\|$/);
  });

  it("adds a model column when a host map is supplied", () => {
    const table = renderModelRoutingTable(DEFAULT_HOST_MODELS.claude);
    expect(table).toContain("Model");
    expect(table).toContain("haiku");
    expect(table).toContain("opus");
  });

  it("omits the model column when the host has no verifiable names", () => {
    const table = renderModelRoutingTable(DEFAULT_HOST_MODELS.opencode);
    expect(table).not.toContain("Model");
  });
});
