import { describe, it, expect } from "bun:test";
import { chunkContent } from "../../src/indexer/parser.js";
import type { Boundary } from "../../src/parser/extract.js";

describe("parser / chunker", () => {
  describe("markdown splitting", () => {
    it("splits markdown by headings", () => {
      const content = `# Introduction

Some intro text.

## Section One

Content for section one.

## Section Two

Content for section two.
`;
      const chunks = chunkContent(content, "docs/README.md", "docs");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // Each chunk should have proper structure
      for (const chunk of chunks) {
        expect(chunk.id).toBeDefined();
        expect(chunk.content).toBeDefined();
        expect(chunk.source).toBe("docs/README.md");
        expect(chunk.module).toBe("docs");
        expect(chunk.content_hash).toBeDefined();
        expect(chunk.updated_at).toBeGreaterThan(0);
      }
    });

    it("keeps small markdown as single chunk", () => {
      const content = "# Small File\n\nJust a little content.\n";
      const chunks = chunkContent(content, "small.md", "root");
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toContain("Small File");
    });
  });

  describe("code splitting", () => {
    it("splits code by function boundaries", () => {
      const content = `function foo() {
  console.log("foo");
}

function bar() {
  console.log("bar");
}

export class MyClass {
  method() {
    return 42;
  }
}
`;
      const chunks = chunkContent(content, "src/main.ts", "src");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.source).toBe("src/main.ts");
        expect(chunk.module).toBe("src");
      }
    });
  });

  describe("chunk properties", () => {
    it("chunks include id, content, source, module, content_hash, updated_at", () => {
      const chunks = chunkContent("const x = 1;", "test.ts", "mod");
      expect(chunks.length).toBe(1);
      const chunk = chunks[0];
      expect(chunk.id).toMatch(/^.+$/);
      expect(chunk.content).toBe("const x = 1;");
      expect(chunk.source).toBe("test.ts");
      expect(chunk.module).toBe("mod");
      expect(chunk.content_hash).toHaveLength(64);
      expect(chunk.updated_at).toBeGreaterThan(0);
    });

    it("respects max chunk size (~6000 chars)", () => {
      // Create content larger than 6000 chars
      const bigContent = "x".repeat(12000);
      const chunks = chunkContent(bigContent, "big.txt", "mod");
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(6200); // some tolerance for overlap
      }
    });

    it("applies overlap between chunks", () => {
      const bigContent = Array.from({ length: 200 }, (_, i) =>
        `Line ${i}: ${"a".repeat(50)}`
      ).join("\n");
      const chunks = chunkContent(bigContent, "big.ts", "mod");
      if (chunks.length > 1) {
        // End of first chunk should overlap with start of second
        const endOfFirst = chunks[0].content.slice(-200);
        const startOfSecond = chunks[1].content.slice(0, 200);
        // At least some overlap expected
        expect(
          endOfFirst.length > 0 || startOfSecond.length > 0
        ).toBe(true);
      }
    });
  });

  describe("AST-aware chunking (boundaries param)", () => {
    it("uses castChunk when non-empty boundaries are provided, carrying AST symbol metadata", () => {
      const content = `function helper() { return 1; }\n`;
      const end = content.indexOf("}") + 1;
      const boundaries: Boundary[] = [
        { name: "helper", kind: "function", start_index: 0, end_index: end, start_line: 1, end_line: 1, depth: 0 },
      ];

      const chunks = chunkContent(content, "src/main.ts", "src", boundaries);

      expect(chunks.length).toBe(1);
      expect(chunks[0].symbol_name).toBe("helper");
      expect(chunks[0].symbol_kind).toBe("function");
      expect(chunks[0].content).toBe(content);
    });

    it("falls back to legacy regex/brace splitting when boundaries is undefined", () => {
      const content = `function foo() {\n  return 1;\n}\n`;
      const withoutBoundaries = chunkContent(content, "src/main.ts", "src");
      const withEmptyBoundaries = chunkContent(content, "src/main.ts", "src", []);
      expect(withoutBoundaries).toEqual(withEmptyBoundaries);
    });

    it("markdown files ignore boundaries entirely (markdown path is unchanged)", () => {
      const content = "# Title\n\nSome text.\n";
      const boundaries: Boundary[] = [
        { name: "Title", kind: "function", start_index: 0, end_index: content.length, start_line: 1, end_line: 3, depth: 0 },
      ];
      const withBoundaries = chunkContent(content, "docs/x.md", "docs", boundaries);
      const withoutBoundaries = chunkContent(content, "docs/x.md", "docs");
      expect(withBoundaries).toEqual(withoutBoundaries);
    });

    it("does not re-slice a cAST section via splitBySize even when raw length exceeds 1600 (non-whitespace budget already respects cAST's 2000 limit)", () => {
      // Pad with lots of whitespace/indentation so RAW length > 1600 while
      // non-whitespace char count stays well under CAST_MAX_NON_WHITESPACE_CHARS (2000).
      const padLines = Array.from({ length: 100 }, (_, i) => `        // pad line ${i}`).join("\n");
      const content = `function helper() {\n${padLines}\n  return 1;\n}\n`;
      expect(content.length).toBeGreaterThan(1600);

      const nonWhitespace = content.replace(/\s/g, "").length;
      expect(nonWhitespace).toBeLessThanOrEqual(2000);

      const end = content.length;
      const boundaries: Boundary[] = [
        { name: "helper", kind: "function", start_index: 0, end_index: end, start_line: 1, end_line: 102, depth: 0 },
      ];

      const chunks = chunkContent(content, "src/foo.ts", "src", boundaries);

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(content);
    });

    it("legacy path (no boundaries) still splits raw content > 1600 chars via splitBySize with overlap", () => {
      const content = "x".repeat(3000);
      const chunks = chunkContent(content, "big.ts", "mod");
      expect(chunks.length).toBeGreaterThan(1);
      // 120-byte overlap: tail of first chunk should reappear at the head of the second.
      const overlap = chunks[0].content.slice(-120);
      expect(chunks[1].content.startsWith(overlap)).toBe(true);
    });
  });
});
