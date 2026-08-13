import { describe, it, expect } from "bun:test";
import { getModelRoutingSection } from "../../src/rules/model-routing.js";
import { getRegistrars } from "../../src/registrars/types.js";
import { ROUTING_CONTENT_VERSION, MODEL_ROUTING } from "../../src/constants.js";
import { mergeRoutingConfig } from "../../src/rules/model-routing-config.js";

const registrars = await getRegistrars();
const eligible = registrars.filter((r) => r.routing);

describe("registrar routing descriptors", () => {
  it("marks exactly the six hosts that write a rules file as eligible", () => {
    expect(eligible.map((r) => r.name).sort()).toEqual(
      ["Claude Code", "Codex", "Cursor", "Gemini CLI", "Windsurf", "Opencode"].sort()
    );
  });

  it("says where each host chooses the model, and how", () => {
    for (const r of eligible) {
      expect(["per-spawn", "agent-definition"]).toContain(r.routing!.mechanism);
      expect(r.routing!.howToApply.length).toBeGreaterThan(0);
    }
  });

  it("names a per-call label field only where one actually exists", () => {
    // Claude Code is the only host with a per-call label: the Agent tool's
    // `description`. Everywhere else the visible name belongs to the agent
    // DEFINITION, so a per-call model prefix has nowhere to go.
    const withLabel = eligible.filter((r) => r.routing!.labelField !== null);
    expect(withLabel.map((r) => r.name)).toEqual(["Claude Code"]);
  });
});

describe("getModelRoutingSection", () => {
  const resolved = mergeRoutingConfig(null);

  it("renders one section per eligible host with no placeholders left", async () => {
    for (const r of eligible) {
      const content = await getModelRoutingSection(r, resolved);
      expect(content).not.toMatch(/\{\{\w+\}\}/);
      expect(content).toContain("Model routing for delegated agents");
    }
  });

  it("embeds the content version so a stale section can be detected", async () => {
    const content = await getModelRoutingSection(registrars[0]!, resolved);
    expect(content).toContain(`model-routing-version: ${ROUTING_CONTENT_VERSION}`);
  });

  it("never tells a non-Claude host to pass Claude's model param", async () => {
    for (const r of eligible) {
      if (r.name === "Claude Code") continue;
      const content = await getModelRoutingSection(r, resolved);
      expect(content).not.toContain("Agent tool");
      expect(content).not.toMatch(/`model` param/);
    }
  });

  it("names concrete models where the host has them", async () => {
    const claude = eligible.find((r) => r.name === "Claude Code")!;
    const content = await getModelRoutingSection(claude, resolved);
    expect(content).toContain("haiku");
    expect(content).toContain("opus");
  });

  it("points at the user config instead of guessing where it has no names", async () => {
    const opencode = eligible.find((r) => r.name === "Opencode")!;
    const content = await getModelRoutingSection(opencode, resolved);
    expect(content).toContain("model-routing.json");
  });

  it("renders the label rule only where a per-call label field exists", async () => {
    for (const r of eligible) {
      const content = await getModelRoutingSection(r, resolved);
      const hasRule = content.includes("haiku: locate auth handler");
      expect(hasRule).toBe(r.routing!.labelField !== null);
    }
  });

  it("carries the guidance the table cannot express", async () => {
    const content = await getModelRoutingSection(registrars[0]!, mergeRoutingConfig(null));
    for (const heading of [
      "When NOT to delegate",
      "Escalate",
      "asymmetric",
      "second axis",
      "parallel",
    ]) {
      expect(content.toLowerCase()).toContain(heading.toLowerCase());
    }
  });

  it("reflects user overrides rather than the built-in table", async () => {
    const claude = eligible.find((r) => r.name === "Claude Code")!;
    const overridden = mergeRoutingConfig({
      models: { claude: { deep: "fable" } },
      rules: [{ task: "Write a migration", tier: "deep", why: "irreversible" }],
    });
    const content = await getModelRoutingSection(claude, overridden);

    expect(content).toContain("fable");
    expect(content).toContain("Write a migration");
    expect(content).not.toContain("| opus |");
  });

  it("keeps every built-in rule in the rendered table", async () => {
    const content = await getModelRoutingSection(registrars[0]!, mergeRoutingConfig(null));
    for (const rule of MODEL_ROUTING) expect(content).toContain(rule.task);
  });
});
