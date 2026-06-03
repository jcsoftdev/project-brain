import { describe, it, expect } from "bun:test";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { getRegistrars } from "../../src/registrars/types.js";

describe("Registrar types", () => {
  it("AIToolRegistrar interface is implemented by getRegistrars results", async () => {
    const registrars = await getRegistrars();
    expect(Array.isArray(registrars)).toBe(true);
    expect(registrars.length).toBeGreaterThan(0);

    for (const r of registrars) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.isInstalled).toBe("function");
      expect(typeof r.register).toBe("function");
      expect(typeof r.writeRules).toBe("function");
    }
  });

  it("getRegistrars returns all known registrars", async () => {
    const registrars = await getRegistrars();
    const names = registrars.map((r) => r.name);
    expect(names).toContain("Claude Code");
    expect(names).toContain("Codex");
    expect(names).toContain("Gemini CLI");
    expect(names).toContain("Cursor");
  });
});
