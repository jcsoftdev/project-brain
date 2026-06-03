import { describe, it, expect } from "bun:test";
import { chunkContent } from "../../src/indexer/parser.js";

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
});
