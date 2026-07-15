import { describe, it, expect } from "bun:test";
import { parseConceptualizeArgs } from "../../src/commands/conceptualize.js";

describe("parseConceptualizeArgs", () => {
  it("does not mistake the --module value for the root when root is omitted", () => {
    const { root, onlyModule } = parseConceptualizeArgs(["--module", "auth"]);
    expect(root).not.toBe("auth");
    expect(root).toBe(process.cwd());
    expect(onlyModule).toBe("auth");
  });

  it("parses an explicit root together with --module", () => {
    const { root, onlyModule } = parseConceptualizeArgs(["/some/root", "--module", "auth"]);
    expect(root).toBe("/some/root");
    expect(onlyModule).toBe("auth");
  });

  it("parses root alone with no --module flag", () => {
    const { root, onlyModule } = parseConceptualizeArgs(["/some/root"]);
    expect(root).toBe("/some/root");
    expect(onlyModule).toBeUndefined();
  });
});
