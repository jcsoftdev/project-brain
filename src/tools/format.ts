import type { SymbolHit } from "../graph/store.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Format a SymbolHit as a single line: path:start_line  kind name — signature */
export function formatHit(hit: SymbolHit): string {
  return `${hit.path}:${hit.start_line}  ${hit.kind} ${hit.name} — ${hit.signature}`;
}

/** Format an array of SymbolHits into a newline-joined string. */
export function formatHits(hits: SymbolHit[]): string {
  return hits.map(formatHit).join("\n");
}

/** Guard: return an error result when graph store is unavailable. */
export function graphUnavailable(): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "graph store not available", code: "GRAPH_UNAVAILABLE" }) }],
    isError: true,
  };
}
