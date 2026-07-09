import { computeHash } from "./hash.js";
import { castChunk } from "./cast.js";
import type { Boundary } from "../parser/extract.js";

const MAX_CHUNK_SIZE = 1600;
const OVERLAP_SIZE = 120;

interface RawChunk {
  id: string;
  content: string;
  source: string;
  module: string;
  content_hash: string;
  updated_at: number;
  symbol_name?: string;
  symbol_kind?: string;
  signature?: string;
  start_line?: number;
  end_line?: number;
}

export interface Section {
  content: string;
  symbol_name?: string;
  symbol_kind?: string;
  signature?: string;
  start_line?: number;
  end_line?: number;
}

/** Markdown file extensions. */
const MD_EXTENSIONS = [".md", ".mdx", ".markdown"];

/**
 * Chunk file content into semantically meaningful pieces.
 * Markdown: split by headings. Code: split by real AST declaration
 * boundaries (cAST, src/indexer/cast.ts) when `boundaries` is provided and
 * non-empty; otherwise falls back to the legacy regex/brace-counter
 * splitCode — used for markdown, unsupported languages, parse failures, and
 * oversize-skipped files, none of which ever produce AST boundaries.
 */
export function chunkContent(
  content: string,
  source: string,
  module: string,
  boundaries?: Boundary[]
): RawChunk[] {
  const ext = source.includes(".") ? "." + source.split(".").pop()! : "";
  const isMarkdown = MD_EXTENSIONS.includes(ext.toLowerCase());

  const sections = isMarkdown
    ? splitMarkdown(content)
    : boundaries && boundaries.length > 0
      ? castChunk(content, boundaries)
      : splitCode(content, ext);

  const chunks: RawChunk[] = [];
  const now = Date.now();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionContent = section.content;

    // If a section exceeds max size, split it further
    if (sectionContent.length > MAX_CHUNK_SIZE) {
      const subChunks = splitBySize(sectionContent);
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push(makeChunk(subChunks[j], source, module, now, i, j, section));
      }
    } else {
      chunks.push(makeChunk(sectionContent, source, module, now, i, undefined, section));
    }
  }

  return chunks.length > 0 ? chunks : [makeChunk(content, source, module, now, 0)];
}

function makeChunk(
  content: string,
  source: string,
  module: string,
  now: number,
  sectionIdx: number,
  subIdx?: number,
  section?: Section
): RawChunk {
  const suffix = subIdx !== undefined ? `-${sectionIdx}-${subIdx}` : `-${sectionIdx}`;
  const id = `${computeHash(source)}${suffix}`;
  return {
    id,
    content,
    source,
    module,
    content_hash: computeHash(content),
    updated_at: now,
    symbol_name: section?.symbol_name,
    symbol_kind: section?.symbol_kind,
    signature: section?.signature,
    start_line: section?.start_line,
    end_line: section?.end_line,
  };
}

/** Split markdown content by headings. */
function splitMarkdown(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: string[] = [];
  let currentStartLine = 1;
  let currentSymbolName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const headingMatch = /^(#{1,3})\s+(.+)/.exec(line);

    if (headingMatch && current.length > 0) {
      const sectionContent = current.join("\n").trim();
      if (sectionContent.length > 0) {
        sections.push({
          content: sectionContent,
          symbol_kind: "section",
          symbol_name: currentSymbolName,
          signature: currentSymbolName,
          start_line: currentStartLine,
          end_line: lineNum - 1,
        });
      }
      currentStartLine = lineNum;
      currentSymbolName = headingMatch[2].trim();
      current = [line];
    } else {
      if (current.length === 0) {
        currentStartLine = lineNum;
        const headingMatchFirst = /^(#{1,3})\s+(.+)/.exec(line);
        if (headingMatchFirst) {
          currentSymbolName = headingMatchFirst[2].trim();
        }
      }
      current.push(line);
    }
  }

  if (current.length > 0) {
    const sectionContent = current.join("\n").trim();
    if (sectionContent.length > 0) {
      sections.push({
        content: sectionContent,
        symbol_kind: "section",
        symbol_name: currentSymbolName,
        signature: currentSymbolName,
        start_line: currentStartLine,
        end_line: lines.length,
      });
    }
  }

  return sections;
}

/** Per-language top-level declaration patterns. */
const DECLARATION_PATTERNS: Record<string, RegExp[]> = {
  // JavaScript / TypeScript
  ".js":  [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/, /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, /^(export\s+)?enum\s/],
  ".ts":  [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/, /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, /^(export\s+)?enum\s/],
  ".tsx": [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/],
  ".jsx": [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?class\s/],
  // Kotlin / KMP
  ".kt":  [
    /^(private\s+|public\s+|internal\s+|protected\s+)?(override\s+)?(inline\s+)?(suspend\s+)?fun\s/,
    /^(expect|actual)\s+(inline\s+)?(suspend\s+)?fun\s/,
    /^@\w+.*\n?(private\s+|public\s+|internal\s+|protected\s+)?(data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?class\s/,
    /^(private\s+|public\s+|internal\s+|protected\s+)?(data\s+|sealed\s+|abstract\s+|open\s+|inner\s+|value\s+)?class\s/,
    /^(expect|actual)\s+(data\s+|sealed\s+|abstract\s+|open\s+|value\s+)?class\s/,
    /^(private\s+|public\s+|internal\s+)?(data\s+|companion\s+)?object\s/,
    /^(private\s+|public\s+|internal\s+|protected\s+)?(fun\s+)?interface\s/,
    /^(private\s+|public\s+|internal\s+)?enum\s+class\s/,
    /^(private\s+|public\s+|internal\s+)?typealias\s/,
    /^(private\s+|public\s+|internal\s+)?annotation\s+class\s/,
  ],
  ".kts": [/^(private\s+|public\s+)?(suspend\s+)?fun\s/, /^(data\s+|sealed\s+|abstract\s+)?class\s/, /^object\s/, /^val\s/, /^var\s/],
  // Java
  ".java": [
    /^(public|private|protected)(\s+static)?(\s+final)?\s+(class|interface|enum|record|@interface)\s/,
    /^(public|private|protected)(\s+static)?(\s+final)?(\s+synchronized)?\s+[\w<>\[\]]+\s+\w+\s*\(/,
    /^static\s+\{/,
  ],
  // Python
  ".py":  [/^(async\s+)?def\s/, /^class\s/, /^@\w+/],
  // Rust
  ".rs":  [
    /^(pub(\([\w:]+\))?\s+)?(async\s+)?(unsafe\s+)?fn\s/,
    /^(pub(\([\w:]+\))?\s+)?(struct|enum|trait|impl|mod|union)\s/,
    /^(pub(\([\w:]+\))?\s+)?type\s/,
    /^(pub(\([\w:]+\))?\s+)?const\s/,
    /^(pub(\([\w:]+\))?\s+)?static\s/,
    /^macro_rules!\s/,
  ],
  // Swift
  ".swift": [
    /^(public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|package\s+)?(override\s+)?(class\s+|static\s+)?(async\s+)?func\s/,
    /^(public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|package\s+)?(final\s+)?(class|struct|protocol|enum|extension|actor|nonisolated)\s/,
    /^@\w+/,
  ],
  // Go
  ".go":  [
    /^func\s/,                          // functions and methods
    /^type\s+\w+\s/,                    // type declarations (struct, interface, alias)
    /^var\s+\(/,                        // var blocks
    /^const\s+\(/,                      // const blocks
    /^var\s+\w+\s/,                     // single var
    /^const\s+\w+\s/,                   // single const
  ],
  // Dart / Flutter
  ".dart": [
    /^(abstract\s+|base\s+|final\s+|interface\s+|mixin\s+|sealed\s+)?(class|enum|mixin|extension|typedef)\s/,
    /^(Future|Stream|void|Widget|[\w<>]+)\s+\w+\s*[(<]/,
    /^(static\s+)?(final\s+|const\s+|late\s+)?[\w<>]+\s+\w+\s*(=|;)/,
  ],
  // C#
  ".cs":  [
    /^(public|private|protected|internal|static|abstract|sealed|partial|\s)+(class|interface|enum|struct|record|delegate)\s/,
    /^(public|private|protected|internal|static|async|override|virtual|abstract|\s)+(Task|void|string|int|bool|[\w<>\[\]?]+)\s+\w+\s*[(<]/,
  ],
  // PHP
  ".php": [/^(abstract\s+|final\s+)?(class|interface|trait|enum)\s/, /^(public|private|protected|static|\s)+(function)\s/, /^function\s/],
  // Ruby
  ".rb":  [/^(def\s)/, /^(class\s)/, /^(module\s)/, /^(attr_(reader|writer|accessor))\s/],
  // C / C++
  ".c":   [/^\w[\w\s\*]+\s+\w+\s*\(/, /^typedef\s/],
  ".cpp": [/^\w[\w\s\*:<>]+\s+\w+\s*\(/, /^(class|struct|namespace|template)\s/, /^typedef\s/],
  ".h":   [/^\w[\w\s\*]+\s+\w+\s*\(/, /^(class|struct|namespace|template)\s/, /^#define\s/],
  ".hpp": [/^\w[\w\s\*:<>]+\s+\w+\s*\(/, /^(class|struct|namespace|template)\s/, /^typedef\s/],
};

/** Get declaration patterns for a file extension. */
function getPatternsForExt(ext: string): RegExp[] {
  return DECLARATION_PATTERNS[ext.toLowerCase()] ?? DECLARATION_PATTERNS[".ts"]!;
}

/**
 * Count net brace depth for a line, ignoring braces inside string/char literals
 * and line/block comments.
 */
function countBraces(line: string, state: { inBlock: boolean }): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlock) {
      if (ch === "*" && next === "/") { state.inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && next === "/") break;            // line comment
    if (ch === "/" && next === "*") { state.inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }
  return depth;
}

/**
 * Extract symbol name and kind from a declaration line (best-effort, language-agnostic).
 */
function extractSymbol(line: string): { name: string; kind: string } {
  const t = line.trim();
  const m = t.match(/\b(function|class|interface|type|enum|struct|trait|impl|fn|def|func|val|var|const)\b\s+([A-Za-z_][\w]*)/)
    ?? t.match(/\b([A-Za-z_][\w]*)\s*[:=]\s*(?:async\s*)?\(/)   // const f = (..) =>
    ?? t.match(/\b([A-Za-z_][\w]*)\s*\(/);                      // method(...)
  if (!m) return { name: "", kind: "unknown" };
  const kw = /^(function|class|interface|type|enum|struct|trait|impl|fn|def|func|val|var|const)$/.test(m[1] ?? "");
  return { name: (kw ? m[2] : m[1]) ?? "", kind: kw ? (m[1] as string) : "function" };
}

/** Split code content by function/class boundaries (language-aware). */
function splitCode(content: string, ext = ""): Section[] {
  const patterns = getPatternsForExt(ext);
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: string[] = [];
  let braceDepth = 0;
  const braceState = { inBlock: false };

  // Track symbol metadata for current section
  let currentSymbolName: string | undefined;
  let currentSymbolKind: string | undefined;
  let currentSignature: string | undefined;
  let currentStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trimStart();
    const isDeclaration = braceDepth === 0 && patterns.some((re) => re.test(trimmed));

    if (isDeclaration && current.length > 0) {
      const sectionContent = current.join("\n").trim();
      if (sectionContent.length > 0) {
        sections.push({
          content: sectionContent,
          symbol_name: currentSymbolName,
          symbol_kind: currentSymbolKind,
          signature: currentSignature,
          start_line: currentStartLine,
          end_line: lineNum - 1,
        });
      }
      // Start new section
      const sym = extractSymbol(line);
      currentSymbolName = sym.name || undefined;
      currentSymbolKind = sym.kind !== "unknown" ? sym.kind : undefined;
      currentSignature = line.trim().slice(0, 160) || undefined;
      currentStartLine = lineNum;
      current = [line];
    } else {
      if (current.length === 0) {
        // First line of the whole file — check if it's a declaration
        if (isDeclaration || braceDepth === 0) {
          const sym = extractSymbol(line);
          currentSymbolName = sym.name || undefined;
          currentSymbolKind = sym.kind !== "unknown" ? sym.kind : undefined;
          currentSignature = line.trim().slice(0, 160) || undefined;
          currentStartLine = lineNum;
        }
      }
      current.push(line);
    }

    braceDepth = Math.max(0, braceDepth + countBraces(line, braceState));
  }

  if (current.length > 0) {
    const sectionContent = current.join("\n").trim();
    if (sectionContent.length > 0) {
      sections.push({
        content: sectionContent,
        symbol_name: currentSymbolName,
        symbol_kind: currentSymbolKind,
        signature: currentSignature,
        start_line: currentStartLine,
        end_line: lines.length,
      });
    }
  }

  return sections;
}

/** Split content by max size with overlap. */
function splitBySize(content: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(start + MAX_CHUNK_SIZE, content.length);
    chunks.push(content.slice(start, end));
    start = end - OVERLAP_SIZE;
    if (start >= content.length - OVERLAP_SIZE) break;
  }

  // Ensure we capture the tail
  if (chunks.length > 0 && start < content.length) {
    const lastChunk = content.slice(start);
    if (lastChunk.length > 0 && lastChunk !== chunks[chunks.length - 1]) {
      chunks.push(lastChunk);
    }
  }

  return chunks;
}
