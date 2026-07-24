import { describe, it, expect } from "bun:test";
import { getModelRoutingSection } from "../../src/rules/model-routing.js";
import { renderModelRoutingTable } from "../../src/constants.js";

describe("getModelRoutingSection", () => {
  it("fills the {{modelRoutingTable}} placeholder", async () => {
    const content = await getModelRoutingSection();
    expect(content).not.toContain("{{modelRoutingTable}}");
    expect(content).toContain(renderModelRoutingTable());
  });

  it("includes the model-routing heading and Agent/Task tool guidance", async () => {
    const content = await getModelRoutingSection();
    expect(content).toContain("Model routing for delegated agents");
    expect(content).toContain("model");
  });
});
