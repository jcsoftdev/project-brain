import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "docs");

describe("extract-text", () => {
  describe("isProbablyText", () => {
    it("treats ordinary UTF-8 text as text", async () => {
      const { isProbablyText } = await import("../../src/indexer/extract-text.js");
      const buf = new TextEncoder().encode("hello world\nthis is plain text, no funny business.\n");
      expect(isProbablyText(buf)).toBe(true);
    });

    it("treats a buffer with a NUL byte as binary", async () => {
      const { isProbablyText } = await import("../../src/indexer/extract-text.js");
      const buf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]); // zip-like header w/ NULs
      expect(isProbablyText(buf)).toBe(false);
    });

    it("treats a buffer with a high replacement-char ratio as binary", async () => {
      const { isProbablyText } = await import("../../src/indexer/extract-text.js");
      // Random high-bit bytes that are not valid UTF-8 continuation sequences
      // decode to a run of U+FFFD replacement characters.
      const bytes = new Uint8Array(200).fill(0xff);
      expect(isProbablyText(bytes)).toBe(false);
    });

    it("treats an empty buffer as text (nothing to reject)", async () => {
      const { isProbablyText } = await import("../../src/indexer/extract-text.js");
      expect(isProbablyText(new Uint8Array(0))).toBe(true);
    });
  });

  describe("PDF extraction", () => {
    it("extracts embedded text from a real PDF", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const text = await readIndexableText(join(FIXTURES, "sample.pdf"), ".pdf");
      expect(text).not.toBeNull();
      expect(text).toContain("Hello PDF");
    });

    it("accepts a scanned/no-text-layer PDF as an empty (non-error) result", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = await readIndexableText(join(FIXTURES, "scanned-empty.pdf"), ".pdf");
        expect(text).not.toBeNull();
        expect(text!.trim()).toBe("");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("returns null and warns on a corrupt PDF", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = await readIndexableText(join(FIXTURES, "corrupt.pdf"), ".pdf");
        expect(text).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        // pdf.js itself may also console.warn while attempting to rebuild a
        // broken xref table — assert only that OUR failure line is present
        // somewhere among the calls, not that it's the first one.
        expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("[extract]"))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("DOCX extraction", () => {
    it("extracts raw text from a real DOCX", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const text = await readIndexableText(join(FIXTURES, "sample.docx"), ".docx");
      expect(text).not.toBeNull();
      expect(text).toContain("Walking on imported air");
    });

    it("handles an effectively-empty docx as a non-error empty/near-empty result", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = await readIndexableText(join(FIXTURES, "empty.docx"), ".docx");
        expect(text).not.toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("returns null and warns on a corrupt DOCX", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = await readIndexableText(join(FIXTURES, "corrupt.docx"), ".docx");
        expect(text).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("XLSX extraction", () => {
    it("renders header-anchored rows under a ## <sheetName> heading", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const text = await readIndexableText(join(FIXTURES, "sample.xlsx"), ".xlsx");
      expect(text).not.toBeNull();
      expect(text).toContain("## People");
      expect(text).toContain("Name: Ada; Age: 36; City: London");
      // Sparse cell (empty City for Grace) must be skipped, not rendered as "City: ".
      expect(text).toContain("Name: Grace; Age: 85");
      expect(text).not.toContain("Grace; Age: 85; City:");
    });

    it("emits no section for an empty worksheet", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const text = await readIndexableText(join(FIXTURES, "sample.xlsx"), ".xlsx");
      expect(text).not.toContain("## Empty");
    });

    it("falls back to tab-joined cell text when there is no header row", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const text = await readIndexableText(join(FIXTURES, "sample.xlsx"), ".xlsx");
      expect(text).toContain("## NoHeader");
      expect(text).toContain("raw\ttab\tjoined");
    });

    it("returns null and warns on a corrupt XLSX", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const text = await readIndexableText(join(FIXTURES, "corrupt.xlsx"), ".xlsx");
        expect(text).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("non-doc dispatch (sniff path)", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "brain-extract-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("returns file content unchanged for a plain text file", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const p = join(tempDir, "notes.txt");
      await writeFile(p, "just some plain notes\n");
      const text = await readIndexableText(p, ".txt");
      expect(text).toBe("just some plain notes\n");
    });

    it("returns null silently (no console.warn) for a binary file with no recognized doc extension", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const p = join(tempDir, "image.png");
        // PNG magic bytes + a NUL byte — sniff must reject this as binary.
        await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]));
        const text = await readIndexableText(p, ".png");
        expect(text).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("returns content for an extensionless legitimate text file (e.g. LICENSE)", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const p = join(tempDir, "LICENSE");
      await writeFile(p, "MIT License\n\nCopyright...\n");
      const text = await readIndexableText(p, "");
      expect(text).toBe("MIT License\n\nCopyright...\n");
    });

    it("rejects binary content that starts with a UTF-16 BOM (0xFF 0xFE) even though Bun's .text() would decode it without NUL/replacement chars", async () => {
      // Regression test for a real gotcha found during implementation: Bun's
      // .text() auto-detects a leading UTF-16 BOM and transparently re-decodes
      // the WHOLE file as UTF-16, which can silently launder binary bytes into
      // a "clean" string with zero NUL/replacement chars — defeating a
      // post-decode sniff. The sniff must run on raw pre-decode bytes.
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      const p = join(tempDir, "data.bin");
      await writeFile(p, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
      const text = await readIndexableText(p, ".bin");
      expect(text).toBeNull();
    });
  });

  describe("mixed-order processing (unpdf/mammoth resolution ordering gotcha)", () => {
    it("extracts a PDF correctly even when a DOCX was extracted first in this process", async () => {
      const { readIndexableText } = await import("../../src/indexer/extract-text.js");
      // DOCX first — this is the ordering that broke unpdf's internal
      // 'unpdf/pdfjs' resolution before the warm-up fix (see extract-text.ts).
      const docxText = await readIndexableText(join(FIXTURES, "sample.docx"), ".docx");
      expect(docxText).toContain("Walking on imported air");

      const pdfText = await readIndexableText(join(FIXTURES, "sample.pdf"), ".pdf");
      expect(pdfText).not.toBeNull();
      expect(pdfText).toContain("Hello PDF");
    });
  });
});
