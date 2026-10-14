export type SectionKind = "project-brain" | "foreign" | "user";

export interface MemorySection {
  /** Stable handle for `--apply`: `block:<marker id>` or `user:<heading slug>`. */
  id: string;
  kind: SectionKind;
  title: string;
  /** Half-open range of line indexes in the source text. */
  start: number;
  end: number;
  text: string;
  /** chars/4 — an estimate, not a tokenizer. */
  tokens: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface Marker {
  line: number;
  id: string;
  role: "open" | "close";
}

/**
 * Comment-only lines that look like a managed-block fence, in the three styles
 * tools use: `x:start`/`x:end`, `X_START`/`X_END`, and `x`/`/x`.
 */
function markerOf(line: string, index: number): Marker | null {
  const m = line.trim().match(/^<!--\s*(.*?)\s*-->$/);
  if (!m) return null;
  const body = m[1]!.replace(/\s+[—-]\s+.*$/, "");
  let hit: RegExpMatchArray | null;
  if ((hit = body.match(/^(.+):start$/))) return { line: index, id: hit[1]!, role: "open" };
  if ((hit = body.match(/^(.+):end$/))) return { line: index, id: hit[1]!, role: "close" };
  if ((hit = body.match(/^(.+)_START$/))) return { line: index, id: hit[1]!, role: "open" };
  if ((hit = body.match(/^(.+)_END$/))) return { line: index, id: hit[1]!, role: "close" };
  if ((hit = body.match(/^\/(\S+)$/))) return { line: index, id: hit[1]!, role: "close" };
  if (/^[\w.-]+:[\w.:-]+$/.test(body)) return { line: index, id: body, role: "open" };
  return null;
}

/** Outermost fenced ranges; an opener with no matching closer is not a block. */
function managedRanges(lines: string[]): { id: string; start: number; end: number }[] {
  const markers = lines.map(markerOf).filter((m): m is Marker => m !== null);
  const ranges: { id: string; start: number; end: number }[] = [];
  let cursor = -1;
  for (const open of markers) {
    if (open.role !== "open" || open.line <= cursor) continue;
    const close = markers.find((m) => m.role === "close" && m.id === open.id && m.line > open.line);
    if (!close) continue;
    ranges.push({ id: open.id, start: open.line, end: close.line + 1 });
    cursor = close.line;
  }
  return ranges;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "section";
}

/** Split user-written text on level-1/2 headings, ignoring fenced code. */
function headingSections(lines: string[], from: number, to: number): { title: string; start: number; end: number }[] {
  const starts: { title: string; start: number }[] = [];
  let fenced = false;
  for (let i = from; i < to; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fenced = !fenced;
    const h = !fenced && lines[i]!.match(/^#{1,2}\s+(.+?)\s*#*$/);
    if (h) starts.push({ title: h[1]!, start: i });
  }
  const out: { title: string; start: number; end: number }[] = [];
  const first = starts[0]?.start ?? to;
  if (first > from) out.push({ title: "(preamble)", start: from, end: first });
  starts.forEach((s, i) => out.push({ title: s.title, start: s.start, end: starts[i + 1]?.start ?? to }));
  return out;
}

export function parseMemoryFile(text: string): MemorySection[] {
  const lines = text.split("\n");
  const sections: MemorySection[] = [];
  const seen = new Map<string, number>();
  const unique = (id: string) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}-${n}`;
  };
  const push = (kind: SectionKind, id: string, title: string, start: number, end: number) => {
    const body = lines.slice(start, end).join("\n");
    if (!body.trim()) return;
    sections.push({ id: unique(id), kind, title, start, end, text: body, tokens: estimateTokens(body) });
  };

  let cursor = 0;
  const ranges = managedRanges(lines);
  for (const range of [...ranges, { id: "", start: lines.length, end: lines.length }]) {
    for (const h of headingSections(lines, cursor, range.start)) {
      push("user", `user:${slugify(h.title)}`, h.title, h.start, h.end);
    }
    if (range.id) {
      const owned = range.id.startsWith("project-brain");
      push(owned ? "project-brain" : "foreign", `block:${range.id}`, range.id, range.start, range.end);
    }
    cursor = range.end;
  }
  return sections;
}
