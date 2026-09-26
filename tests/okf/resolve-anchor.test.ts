import { describe, it, expect } from "bun:test";
import { resolveAnchorResource } from "../../src/okf/anchors.js";

const layout = { bundleRoot: "/repo/okf", repoRoot: "/repo" };

function deps(existingFiles: Set<string>, symbolsByFile: Record<string, string[]> = {}) {
  return {
    exists: (p: string) => existingFiles.has(p),
    hasSymbol: (path: string, symbol: string) => (symbolsByFile[path] ?? []).includes(symbol),
  };
}

describe("resolveAnchorResource", () => {
  it("resolves a whole-file anchor whose file exists", () => {
    const result = resolveAnchorResource("../src/a.ts", layout, deps(new Set(["src/a.ts"])));
    expect(result.ok).toBe(true);
    expect(result.path).toBe("src/a.ts");
    expect(result.symbol).toBeNull();
  });

  it("resolves a symbol anchor whose file and symbol both exist", () => {
    const result = resolveAnchorResource("../src/a.ts#alpha", layout, deps(new Set(["src/a.ts"]), { "src/a.ts": ["alpha"] }));
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe("alpha");
  });

  it("fails with missing-file when the file does not exist", () => {
    const result = resolveAnchorResource("../src/gone.ts", layout, deps(new Set()));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-file");
  });

  it("fails with missing-symbol when the file exists but the symbol does not", () => {
    const result = resolveAnchorResource("../src/a.ts#nope", layout, deps(new Set(["src/a.ts"]), { "src/a.ts": ["alpha"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-symbol");
  });

  it("resolves a line-range anchor without needing a symbol lookup", () => {
    const result = resolveAnchorResource("../src/a.ts#L10-L20", layout, deps(new Set(["src/a.ts"])));
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual({ start: 10, end: 20 });
  });

  it("fails with unparseable for an external URL", () => {
    const result = resolveAnchorResource("https://example.com/doc", layout, deps(new Set()));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unparseable");
  });

  it("fails with outside-repo when the resource escapes the repository", () => {
    const result = resolveAnchorResource("../../outside.ts", layout, deps(new Set()));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside-repo");
  });
});
