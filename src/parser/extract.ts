import type { SymbolInput, EdgeInput } from "../graph/store";

// Per-language map of node type → symbol kind.
// Node type names confirmed against real grammar outputs from web-tree-sitter.
const DECL_KINDS: Record<string, Record<string, string>> = {
  typescript: {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
  },
  tsx: {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
  },
  javascript: {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
  },
  python: {
    function_definition: "function",
    class_definition: "class",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
  },
  rust: {
    function_item: "function",
    struct_item: "struct",
    impl_item: "impl",
    trait_item: "trait",
  },
};

// Extract the symbol name from a declaration node.
// For TS/JS: the first named child of type "identifier" or "property_identifier".
// We try childForFieldName("name") first (works in some grammars like Python/Go/Rust),
// then fall back to scanning named children for an identifier node.
function nameOf(node: any): string | null {
  // Try field-based access (Python, Go, Rust grammars use "name" field)
  const byField = node.childForFieldName?.("name");
  if (byField) return byField.text ?? null;
  // Fall back: first named child that is an identifier-like node
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const child = node.namedChild(i);
    if (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier"
    ) {
      return child.text ?? null;
    }
  }
  return null;
}

// Walk a subtree collecting call edges. No Query objects — plain node walk.
// kinds: the language's DECL_KINDS map — children whose type is a key in kinds
// are nested declarations that collect their own calls; skip descending into them.
function collectCalls(symbolNode: any, kinds: Record<string, string>, out: EdgeInput[]): void {
  const stack: any[] = [];
  for (let i = 0; i < (symbolNode.namedChildCount ?? 0); i++) stack.push(symbolNode.namedChild(i));
  while (stack.length) {
    const n = stack.pop();
    if (kinds[n.type]) continue; // nested declaration → it collects its own calls
    if (n.type === "call_expression" || n.type === "call") {
      // Callee is the first named child (TS/JS: identifier or member_expression)
      const callee = n.namedChild?.(0);
      if (callee) {
        if (callee.type === "identifier") {
          out.push({ dst_name: callee.text, edge_type: "call" });
        } else if (callee.type === "member_expression") {
          // e.g. obj.method() — use last identifier component
          const last = callee.namedChild?.(callee.namedChildCount - 1);
          if (last?.text) out.push({ dst_name: last.text, edge_type: "call" });
        }
      }
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) stack.push(n.namedChild(i));
  }
}

// Walk the full AST and extract symbols with their call edges.
// Uses plain node iteration — no Query/cursor objects, nothing to leak.
export function extract(tree: any, langId: string, _source: string): SymbolInput[] {
  const kinds = DECL_KINDS[langId] ?? DECL_KINDS.typescript;
  const out: SymbolInput[] = [];
  const stack: any[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    const kind = kinds[n.type];
    if (kind) {
      const name = nameOf(n);
      if (name) {
        const edges: EdgeInput[] = [];
        collectCalls(n, kinds, edges);
        const sig = n.text.split("\n")[0].slice(0, 160);
        out.push({
          name,
          kind,
          signature: sig,
          start_line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1,
          edges,
        });
        // Don't skip children — nested functions (e.g. methods inside class) need to be found.
      }
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) stack.push(n.namedChild(i));
  }
  return out;
}
