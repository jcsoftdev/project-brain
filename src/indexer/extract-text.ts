import { MAX_EXTRACTED_TEXT_CHARS } from "../constants.js";
import type { Worksheet, CellValue } from "exceljs";

/**
 * Doc-family extensions handled by dedicated extractors below. Every other
 * extension goes through the plain `.text()` read + `isProbablyText` sniff
 * gate (see readIndexableText). Exported so sync.ts can apply the correct
 * size ceiling (MAX_DOC_FILE_BYTES vs MAX_TEXT_FILE_BYTES) and parser.ts can
 * route these extensions through the markdown/prose chunking path — kept in
 * ONE place so the two call sites can never drift.
 */
export const DOC_EXTENSIONS = [".pdf", ".docx", ".xlsx"] as const;

export function isDocExtension(ext: string): boolean {
  return (DOC_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** Bytes of the sniff window — matches git's own text/binary heuristic window. */
const SNIFF_BYTES = 8192;
/** Above this replacement-char ratio in the sniff window, treat content as binary. */
const REPLACEMENT_RATIO_THRESHOLD = 0.1;
const REPLACEMENT_CHAR = "�";

/**
 * Content-sniff binary detector — the SAME heuristic git itself uses to
 * decide if a file is text or binary (NUL byte in the first several KB),
 * extended with a high-replacement-char-ratio check so invalid-UTF-8 binary
 * formats with no embedded NUL (some image/archive formats) are also caught.
 *
 * Deliberately NOT an extension allowlist: an allowlist would regress files
 * that index fine today despite having no/rare extensions (LICENSE, Makefile,
 * Dockerfile, .env.example, arbitrary .txt/.csv) — sniffing content instead
 * fixes the mojibake bug for every binary type with zero regression risk on
 * legitimate text.
 */
export function isProbablyText(buffer: Uint8Array | Buffer): boolean {
  if (buffer.length === 0) return true;
  const window = buffer.subarray(0, SNIFF_BYTES);

  for (let i = 0; i < window.length; i++) {
    if (window[i] === 0) return false;
  }

  const decoded = new TextDecoder("utf-8").decode(window);
  if (decoded.length === 0) return true;

  let replacementCount = 0;
  for (const ch of decoded) {
    if (ch === REPLACEMENT_CHAR) replacementCount++;
  }
  return replacementCount / decoded.length <= REPLACEMENT_RATIO_THRESHOLD;
}

/** Truncate extracted text to the cost-guard cap — never reject, just cap. */
function truncate(text: string): string {
  return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
}

function warnFailure(filePath: string, err: unknown): null {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[extract] ${reason}: ${filePath}`);
  return null;
}

/**
 * Warms unpdf's internal pdfjs module resolution BEFORE mammoth or exceljs
 * ever get imported into the process.
 *
 * Gotcha discovered during the exceljs/unpdf integration spike: if `mammoth`
 * is dynamically imported before unpdf's FIRST `getDocumentProxy`/`extractText`
 * call, unpdf's own dynamic resolution of its `unpdf/pdfjs` subpath export
 * silently breaks under Bun ("Cannot find module 'unpdf/pdfjs'") — a Bun
 * module-resolution interaction between the two packages' dependency trees.
 * Calling `getResolvedPDFJS()` once, this early (before any doc extraction of
 * ANY format), permanently fixes the resolution for the rest of the process,
 * even after mammoth/exceljs load afterward. Memoized so it only does real
 * work once; a failure here is swallowed and naturally resurfaces as an
 * ordinary extraction failure at call time instead of crashing warm-up.
 */
let pdfjsWarmup: Promise<void> | null = null;
function warmPdfjs(): Promise<void> {
  if (!pdfjsWarmup) {
    pdfjsWarmup = import("unpdf")
      .then((m) => m.getResolvedPDFJS())
      .then(() => undefined)
      .catch(() => undefined);
  }
  return pdfjsWarmup;
}

/** Extract embedded text from a PDF. Empty/near-empty result (no text layer, e.g. a scanned PDF) is a valid non-error outcome — no OCR is implemented. */
async function extractPdfText(filePath: string): Promise<string | null> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return truncate(text);
  } catch (err) {
    return warnFailure(filePath, err);
  }
}

/** Extract raw text from a DOCX via mammoth. */
async function extractDocxText(filePath: string): Promise<string | null> {
  try {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ path: filePath });
    return truncate(value);
  } catch (err) {
    return warnFailure(filePath, err);
  }
}

/** Stringify a single ExcelJS cell value (string, number, date, formula, rich text, hyperlink) for row rendering. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (typeof v.text === "string") return v.text; // hyperlink { text, hyperlink }
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map((f) => f.text ?? "").join("");
    }
    if ("result" in v) return cellText(v.result as CellValue); // formula { formula, result }
    if ("error" in v) return String(v.error);
    return "";
  }
  return String(value);
}

/** Dense 0-indexed array of stringified cell values for a row (aligned to column index). */
function cellsOfRow(row: { eachCell: (opts: { includeEmpty: boolean }, cb: (cell: { value: CellValue }, colNumber: number) => void) => void }): string[] {
  const out: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    out[colNumber - 1] = cellText(cell.value);
  });
  return out;
}

/**
 * Render one worksheet as header-anchored rows: row 1 supplies column
 * headers, each subsequent row becomes one line `Header1: value1; Header2:
 * value2; ...` (empty cells skipped). If row 1 has no content at all, there
 * is no header to anchor to — every row (including row 1, which contributes
 * nothing) falls back to tab-joined cell text instead. Returns null for a
 * worksheet with no rows (no section emitted, no chunk).
 */
function renderWorksheet(ws: Worksheet): string | null {
  const lines: string[] = [];
  let headers: string[] | null = null;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = cellsOfRow(row);

    if (rowNumber === 1) {
      const hasHeader = cells.some((c) => c.trim() !== "");
      if (hasHeader) {
        headers = cells;
        return;
      }
      // Row 1 is empty -> no header row; fall through to tab-join below.
    }

    if (headers) {
      const parts: string[] = [];
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i] ?? "";
        if (v.trim() === "") continue;
        const label = headers[i] || `Col${i + 1}`;
        parts.push(`${label}: ${v}`);
      }
      if (parts.length > 0) lines.push(parts.join("; "));
    } else {
      const joined = cells.filter((c) => c.trim() !== "").join("\t");
      if (joined) lines.push(joined);
    }
  });

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Extract an XLSX workbook as prose: for each non-empty worksheet, a
 * `## <sheetName>` heading followed by header-anchored-rows text — real `##`
 * headings so the extracted string routes cleanly through the existing
 * splitMarkdown chunker (src/indexer/parser.ts) with zero new chunking logic.
 */
async function extractXlsxText(filePath: string): Promise<string | null> {
  try {
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    const sections: string[] = [];
    for (const ws of wb.worksheets) {
      const body = renderWorksheet(ws);
      if (body) sections.push(`## ${ws.name}\n${body}`);
    }
    return truncate(sections.join("\n\n"));
  } catch (err) {
    return warnFailure(filePath, err);
  }
}

/**
 * Unified indexable-text reader shared by BOTH sync.ts read sites (the main
 * sync loop and checkStaleness). This is a correctness requirement, not a
 * style preference: if the two sites used different logic, a doc's
 * content-hash would differ between "sync" and "staleness check", causing it
 * to perpetually flag as stale.
 *
 * Dispatch: .pdf/.docx/.xlsx -> dedicated extractor (skips the sniff
 * entirely). Everything else -> raw-byte sniff on the file's head via
 * isProbablyText, THEN the `.text()` read — ordinary binary files (images,
 * archives, etc) fail this gate SILENTLY (no console.warn; this is the
 * common/expected case and would flood logs otherwise). Doc extraction
 * failures WARN (see warnFailure) since the user explicitly expected that
 * file to be indexed.
 *
 * The sniff reads raw pre-decode bytes (file.slice().arrayBuffer()) rather
 * than sniffing content already run through `.text()`: Bun's `.text()`
 * auto-detects a leading UTF-16 BOM (0xFF 0xFE / 0xFE 0xFF) and transparently
 * re-decodes the WHOLE file as UTF-16 — a binary blob that happens to start
 * with those two bytes can decode to a string with zero NUL/replacement
 * chars, silently defeating a post-decode sniff. Sniffing raw bytes first
 * sidesteps that blind spot entirely (and is cheaper: a small partial read
 * instead of decoding + re-encoding the full file just to check the head).
 */
export async function readIndexableText(filePath: string, ext: string): Promise<string | null> {
  const lower = ext.toLowerCase();

  if (isDocExtension(lower)) {
    await warmPdfjs();
    if (lower === ".pdf") return extractPdfText(filePath);
    if (lower === ".docx") return extractDocxText(filePath);
    return extractXlsxText(filePath);
  }

  const file = Bun.file(filePath);
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    return null;
  }
  if (!isProbablyText(head)) return null;

  try {
    return await file.text();
  } catch {
    return null;
  }
}
