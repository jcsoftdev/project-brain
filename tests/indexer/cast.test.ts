import { describe, it, expect } from "bun:test";
import { castChunk, CAST_MAX_NON_WHITESPACE_CHARS } from "../../src/indexer/cast.js";
import type { Boundary } from "../../src/parser/extract.js";
import type { SymbolKind } from "../../src/types.js";

/** Build a Boundary for a slice of `source` spanning [start, end) (byte offsets). */
function boundary(
  source: string,
  name: string,
  kind: SymbolKind,
  start: number,
  end: number,
  depth = 0,
): Boundary {
  const before = source.slice(0, start);
  const startLine = before.split("\n").length;
  const spanLines = source.slice(start, end).split("\n").length;
  return {
    name,
    kind,
    start_index: start,
    end_index: end,
    start_line: startLine,
    end_line: startLine + spanLines - 1,
    depth,
  };
}

describe("castChunk", () => {
  it("merges small adjacent functions into a single chunk under budget", () => {
    const source = `function a() { return 1; }\nfunction b() { return 2; }\n`;
    const aEnd = source.indexOf("}") + 1;
    const bStart = source.indexOf("function b");
    const bEnd = source.lastIndexOf("}") + 1;
    const boundaries: Boundary[] = [
      boundary(source, "a", "function", 0, aEnd),
      boundary(source, "b", "function", bStart, bEnd),
    ];

    const sections = castChunk(source, boundaries);

    expect(sections.length).toBe(1);
    expect(sections[0].content).toBe(source);
  });

  it("splits an oversized class at its method children", () => {
    const method1 = `  method1() {\n${"    doSomethingWithAVeryLongCallExpression();\n".repeat(60)}  }\n`;
    const method2 = `  method2() {\n${"    doSomethingElseWithAnotherLongCall();\n".repeat(60)}  }\n`;
    const source = `class Big {\n${method1}${method2}}\n`;

    const m1Start = source.indexOf("method1() {");
    const m1End = m1Start + method1.length - 1; // exclude trailing \n from the literal's own end computation below
    const m1ActualEnd = source.indexOf("  }\n", m1Start) + 3; // end at closing brace of method1
    const m2Start = source.indexOf("method2() {");
    const m2ActualEnd = source.indexOf("  }\n", m2Start) + 3;

    const classBoundary = boundary(source, "Big", "class", 0, source.length - 1, 0);
    const childBoundaries: Boundary[] = [
      boundary(source, "method1", "method", m1Start, m1ActualEnd, 1),
      boundary(source, "method2", "method", m2Start, m2ActualEnd, 1),
    ];

    const sections = castChunk(source, [classBoundary, ...childBoundaries]);

    // The class alone exceeds CAST_MAX_NON_WHITESPACE_CHARS, so it must be
    // recursively split via its method children into more than one section.
    expect(sections.length).toBeGreaterThan(1);
    const names = sections.map((s) => s.symbol_name);
    expect(names).toContain("method1");
    expect(names).toContain("method2");
  });

  it("loses no bytes — concatenated chunk spans reassemble the whole file", () => {
    const source = `import { x } from "./x";\n\nfunction a() { return x(); }\n\nfunction b() { return a(); }\n`;
    const aStart = source.indexOf("function a");
    const aEnd = source.indexOf("}", aStart) + 1;
    const bStart = source.indexOf("function b");
    const bEnd = source.indexOf("}", bStart) + 1;
    const boundaries: Boundary[] = [
      boundary(source, "a", "function", aStart, aEnd),
      boundary(source, "b", "function", bStart, bEnd),
    ];

    const sections = castChunk(source, boundaries);
    const reassembled = sections.map((s) => s.content).join("");
    expect(reassembled).toBe(source);
  });

  it("attaches leading between-boundary text (imports) to the following node's chunk", () => {
    const source = `import { x } from "./x";\n\nfunction a() { return x(); }\n`;
    const aStart = source.indexOf("function a");
    const aEnd = source.indexOf("}", aStart) + 1;
    const boundaries: Boundary[] = [boundary(source, "a", "function", aStart, aEnd)];

    const sections = castChunk(source, boundaries);

    expect(sections.length).toBe(1);
    expect(sections[0].content).toContain("import { x }");
    expect(sections[0].content).toContain("function a");
  });

  it("carries symbol metadata: name, kind, truncated first-line signature, and real line span", () => {
    const source = `function longNamedHelperFunctionThatDoesSomethingUseful(argumentOne, argumentTwo, argumentThree) {\n  return argumentOne + argumentTwo + argumentThree;\n}\n`;
    const end = source.indexOf("}", source.indexOf("return")) + 1;
    const boundaries: Boundary[] = [boundary(source, "longNamedHelperFunctionThatDoesSomethingUseful", "function", 0, end)];

    const sections = castChunk(source, boundaries);

    expect(sections.length).toBe(1);
    const s = sections[0];
    expect(s.symbol_name).toBe("longNamedHelperFunctionThatDoesSomethingUseful");
    expect(s.symbol_kind).toBe("function");
    expect(s.signature).toBe(source.split("\n")[0].slice(0, 160));
    expect(s.start_line).toBe(1);
    expect(s.end_line).toBe(3);
  });

  it("is deterministic — the same input produces identical chunks across runs", () => {
    const source = `function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\n`;
    const aEnd = source.indexOf("}") + 1;
    const bStart = source.indexOf("function b");
    const bEnd = source.indexOf("}", bStart) + 1;
    const cStart = source.indexOf("function c");
    const cEnd = source.indexOf("}", cStart) + 1;
    const boundaries: Boundary[] = [
      boundary(source, "a", "function", 0, aEnd),
      boundary(source, "b", "function", bStart, bEnd),
      boundary(source, "c", "function", cStart, cEnd),
    ];

    const run1 = castChunk(source, boundaries);
    const run2 = castChunk(source, boundaries);

    expect(run1).toEqual(run2);
  });

  it("falls back gracefully to a single whole-file section when boundaries are empty", () => {
    const source = `plain text with no AST boundaries at all\n`;
    const sections = castChunk(source, []);
    expect(sections.length).toBe(1);
    expect(sections[0].content).toBe(source);
    expect(sections[0].symbol_name).toBeUndefined();
  });

  it("budget is measured in non-whitespace characters — a whitespace-heavy file does not split early", () => {
    // Body is mostly blank lines/indentation; non-whitespace content is tiny.
    const bodyLines = Array.from({ length: 100 }, () => "                    ").join("\n");
    const source = `function a() {\n${bodyLines}\n  return 1;\n}\n`;
    const end = source.lastIndexOf("}") + 1;
    const boundaries: Boundary[] = [boundary(source, "a", "function", 0, end)];

    // Sanity: this source is well over CAST_MAX_NON_WHITESPACE_CHARS in raw
    // length, but its non-whitespace character count is tiny.
    const nonWhitespaceCount = source.replace(/\s/g, "").length;
    expect(nonWhitespaceCount).toBeLessThan(CAST_MAX_NON_WHITESPACE_CHARS);
    expect(source.length).toBeGreaterThan(CAST_MAX_NON_WHITESPACE_CHARS);

    const sections = castChunk(source, boundaries);

    // Must NOT split — the whitespace-heavy single function stays one chunk
    // because the budget counts non-whitespace chars only.
    expect(sections.length).toBe(1);
  });

  it("exports CAST_MAX_NON_WHITESPACE_CHARS as 2000 (paper's setting)", () => {
    expect(CAST_MAX_NON_WHITESPACE_CHARS).toBe(2000);
  });
});
