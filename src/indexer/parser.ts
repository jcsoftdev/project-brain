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
  ".js":  [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/, /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, /^(export\s+)?enum\s/],
  ".ts":  [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/, /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, /^(export\s+)?enum\s/],
  ".tsx": [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?(abstract\s+)?class\s/, /^(export\s+)?interface\s/, /^(export\s+)?type\s+\w+\s*=/],
  ".jsx": [/^(export\s+)?(default\s+)?(async\s+)?function[\s*]/, /^(export\s+)?class\s/],
  // Kotlin / KMP
  ".kt":  [
    /^(private\s+|public\s+|internal\s+|protected\s+)?(override\s+)?(suspend\s+)?fun\s/,
    /^(expect|actual)\s+(suspend\s+)?fun\s/,
    /^(private\s+|public\s+|internal\s+|protected\s+)?(data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?class\s/,
    /^(expect|actual)\s+(data\s+|sealed\s+|abstract\s+|open\s+)?class\s/,
    /^(private\s+|public\s+|internal\s+)?(data\s+)?object\s/,
    /^(private\s+|public\s+|internal\s+)?interface\s/,
    /^(private\s+|public\s+|internal\s+)?enum\s+class\s/,
    /^(private\s+|public\s+|internal\s+)?typealias\s/,
  ],
  ".kts": [/^(private\s+|public\s+)?(suspend\s+)?fun\s/, /^(data\s+|sealed\s+|abstract\s+)?class\s/],
  // Java
  ".java": [/^(public|private|protected|static|\s)+(class|interface|enum|record)\s/, /^(public|private|protected|static|\s)+(void|int|String|boolean|long|double|[\w<>\[\]]+)\s+\w+\s*\(/],
  // Python
  ".py":  [/^(async\s+)?def\s/, /^class\s/],
  // Rust
  ".rs":  [/^(pub(\([\w]+\))?\s+)?(async\s+)?fn\s/, /^(pub(\([\w]+\))?\s+)?(struct|enum|trait|impl|mod)\s/, /^(pub(\([\w]+\))?\s+)?type\s/],
  // Swift
  ".swift": [/^(public\s+|private\s+|internal\s+|open\s+|fileprivate\s+)?(override\s+)?(class\s+|static\s+)?func\s/, /^(public\s+|private\s+|internal\s+|open\s+)?(final\s+)?(class|struct|protocol|enum|extension|actor)\s/],
  // Go
  ".go":  [/^func\s/, /^type\s+\w+\s+(struct|interface)\s/],
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
