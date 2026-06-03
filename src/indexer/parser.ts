import { computeHash } from "./hash.js";

const MAX_CHUNK_SIZE = 6000;
const OVERLAP_SIZE = 200;

interface RawChunk {
  id: string;
  content: string;
  source: string;
  module: string;
  content_hash: string;
  updated_at: number;
}

/** Markdown file extensions. */
const MD_EXTENSIONS = [".md", ".mdx", ".markdown"];

/**
 * Chunk file content into semantically meaningful pieces.
 * Markdown: split by headings. Code: split by function/class boundaries.
 */
export function chunkContent(
  content: string,
  source: string,
  module: string
): RawChunk[] {
  const ext = source.includes(".") ? "." + source.split(".").pop()! : "";
  const isMarkdown = MD_EXTENSIONS.includes(ext.toLowerCase());

  const sections = isMarkdown
    ? splitMarkdown(content)
    : splitCode(content, ext);

  const chunks: RawChunk[] = [];
  const now = Date.now();

  for (let i = 0; i < sections.length; i++) {
    let sectionContent = sections[i];

    // If a section exceeds max size, split it further
    if (sectionContent.length > MAX_CHUNK_SIZE) {
      const subChunks = splitBySize(sectionContent);
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push(makeChunk(subChunks[j], source, module, now, i, j));
      }
    } else {
      chunks.push(makeChunk(sectionContent, source, module, now, i));
    }
  }

  return chunks.length > 0 ? chunks : [makeChunk(content, source, module, now, 0)];
}

/**
 * Read a file and chunk its content.
 */
export async function chunkFile(
  filePath: string,
  project: string,
  module: string
): Promise<RawChunk[]> {
  const content = await Bun.file(filePath).text();
  return chunkContent(content, filePath, module);
}

function makeChunk(
  content: string,
  source: string,
  module: string,
  now: number,
  sectionIdx: number,
  subIdx?: number
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
  };
}

/** Split markdown content by headings. */
function splitMarkdown(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length > 0) {
      const section = current.join("\n").trim();
      if (section.length > 0) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section.length > 0) sections.push(section);
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

/** Split code content by function/class boundaries (language-aware). */
function splitCode(content: string, ext = ""): string[] {
  const patterns = getPatternsForExt(ext);
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isDeclaration = braceDepth === 0 && patterns.some((re) => re.test(trimmed));

    if (isDeclaration && current.length > 0) {
      const section = current.join("\n").trim();
      if (section.length > 0) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }

    for (const char of line) {
      if (char === "{") braceDepth++;
      if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  if (current.length > 0) {
    const section = current.join("\n").trim();
    if (section.length > 0) sections.push(section);
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
