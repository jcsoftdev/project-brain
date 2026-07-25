/**
 * Hidden build-smoke hook: `project-brain __extract-selftest`.
 *
 * Purpose: prove the cross-compiled (`bun build --compile`) binary actually
 * bundles + can run the three pure-JS document extraction libraries (unpdf,
 * mammoth, exceljs) added in this change — WITHOUT touching Ollama, the
 * vector store, or SQLite. Mirrors src/commands/parse-selftest.ts's
 * __parse-selftest hook and output contract exactly.
 *
 * The exceljs check is the highest-value one: unlike unpdf/mammoth (only
 * exercised read-only here), exceljs's WRITE path exercises its own internal
 * zip writer + real filesystem I/O inside the compiled binary — the biggest
 * unknown flagged for this change.
 *
 * The pdf/docx fixtures are self-contained (hand-crafted PDF bytes built at
 * runtime; a tiny valid docx embedded as base64) so this file needs no
 * external test-data directory — the compiled binary has no access to the
 * source tree, only to whatever is embedded in the binary itself.
 *
 * Output contract (parsed by .github/workflows/release.yml):
 *   - On success: prints `EXTRACT_OK <n>` (n = number of formats verified,
 *     currently 3) and exits 0.
 *   - On any failure: prints a diagnostic to stderr and exits 1.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexableText } from "../indexer/extract-text.js";

/**
 * Hand-crafted single-page PDF with an embedded "Hello selftest" text layer
 * — pure ASCII PDF syntax with a correctly computed xref table, no library
 * needed to produce it (same technique used for tests/fixtures/docs/sample.pdf).
 */
function buildMinimalPdf(): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const stream = "BT /F1 24 Tf 10 100 Td (Hello selftest) Tj ET";
  objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets.push(out.length);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(out);
}

/**
 * A real, minimal, valid .docx ([Content_Types].xml + _rels/.rels +
 * word/document.xml, one paragraph "selftest ok"), embedded as base64.
 * Hand-crafting a ZIP container without a zip-writer dependency isn't
 * practical, and pulling in mammoth's internal zip library (jszip) directly
 * here would rely on an undeclared transitive dependency. Base64 keeps this
 * self-contained and immune to any future change in mammoth's internals.
 */
const MINIMAL_DOCX_BASE64 =
  "UEsDBAoAAAAAACMr+VzXeYTquAEAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CjwvVHlwZXM+UEsDBAoAAAAAACMr+VwAAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAAACMr+VwgG4bqLgEAAC4BAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+CjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPgogIDxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz4KPC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAAAjK/lcAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAACMr+VwZ9Cb+4QAAAOEAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT4KICAgIDx3OnA+PHc6cj48dzp0PnNlbGZ0ZXN0IG9rPC93OnQ+PC93OnI+PC93OnA+CiAgPC93OmJvZHk+Cjwvdzpkb2N1bWVudD5QSwECFAAKAAAAAAAjK/lc13mE6rgBAAC4AQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAACMr+VwAAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAAOkBAABfcmVscy9QSwECFAAKAAAAAAAjK/lcIBuG6i4BAAAuAQAACwAAAAAAAAAAAAAAAAANAgAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAAAjK/lcAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAABkAwAAd29yZC9QSwECFAAKAAAAAAAjK/lcGfQm/uEAAADhAAAAEQAAAAAAAAAAAAAAAACHAwAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAlwQAAAAA";

/**
 * Runs all three extractor smoke checks. Returns the number verified (3 on
 * full success). Throws on the first hard failure — the caller (execute)
 * turns that into the EXTRACT_FAIL diagnostic + exit 1.
 */
export async function runExtractSelfTest(): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "pb-extract-selftest-"));
  try {
    let verified = 0;

    // 1. PDF — proves unpdf resolves + extracts inside this binary.
    const pdfPath = join(dir, "selftest.pdf");
    await writeFile(pdfPath, buildMinimalPdf());
    const pdfText = await readIndexableText(pdfPath, ".pdf");
    if (!pdfText || !pdfText.includes("Hello selftest")) {
      throw new Error(`pdf extraction produced unexpected output: ${JSON.stringify(pdfText)}`);
    }
    verified++;

    // 2. DOCX — proves mammoth resolves + extracts inside this binary.
    const docxPath = join(dir, "selftest.docx");
    await writeFile(docxPath, Buffer.from(MINIMAL_DOCX_BASE64, "base64"));
    const docxText = await readIndexableText(docxPath, ".docx");
    if (!docxText || !docxText.includes("selftest ok")) {
      throw new Error(`docx extraction produced unexpected output: ${JSON.stringify(docxText)}`);
    }
    verified++;

    // 3. XLSX — a real write-then-read round trip via exceljs itself: the
    // single biggest at-risk item for this change (full JS zip writer inside
    // a `bun build --compile` binary), not just a read of a pre-baked file.
    const xlsxPath = join(dir, "selftest.xlsx");
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Selftest");
    ws.addRow(["Marker", "Value"]);
    ws.addRow(["ok", "1"]);
    await wb.xlsx.writeFile(xlsxPath);

    const xlsxText = await readIndexableText(xlsxPath, ".xlsx");
    if (!xlsxText || !xlsxText.includes("## Selftest") || !xlsxText.includes("Marker: ok")) {
      throw new Error(`xlsx round-trip produced unexpected output: ${JSON.stringify(xlsxText)}`);
    }
    verified++;

    return verified;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function execute(_args: string[]): Promise<void> {
  try {
    const count = await runExtractSelfTest();
    if (count < 3) {
      console.error(`EXTRACT_FAIL ${count} — not all extractors verified`);
      process.exit(1);
    }
    console.log(`EXTRACT_OK ${count}`);
    process.exit(0);
  } catch (err) {
    console.error(`EXTRACT_FAIL — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
