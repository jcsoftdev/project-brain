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
    : splitCode(content);

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

/** Split code content by function/class boundaries. */
function splitCode(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let braceDepth = 0;

  for (const line of lines) {
    // Detect top-level declarations
    const isDeclaration =
      braceDepth === 0 &&
      (/^(export\s+)?(async\s+)?function\s/.test(line) ||
        /^(export\s+)?(abstract\s+)?class\s/.test(line) ||
        /^(export\s+)?interface\s/.test(line) ||
        /^(export\s+)?type\s/.test(line) ||
        /^(export\s+)?const\s/.test(line) ||
        /^(export\s+)?enum\s/.test(line));

    if (isDeclaration && current.length > 0) {
      const section = current.join("\n").trim();
      if (section.length > 0) sections.push(section);
      current = [line];
    } else {
      current.push(line);
    }

    // Track brace depth for better boundary detection
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
