import type { SymbolInput, EdgeInput } from "../graph/store";
import type { SymbolKind } from "../types";

// Per-language map of node type → symbol kind.
// Node type names confirmed against real grammar outputs from web-tree-sitter.
// Values are typed as SymbolKind so the union in src/types.ts is enforced at
// the source: adding a kind here without extending SymbolKind fails to compile.
const DECL_KINDS: Record<string, Record<string, SymbolKind>> = {
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
  java: {
    class_declaration: "class",
    interface_declaration: "interface",
    method_declaration: "method",
    enum_declaration: "enum",
  },
  c: {
    function_definition: "function",
    struct_specifier: "struct",
  },
  cpp: {
    function_definition: "function",
    class_specifier: "class",
    struct_specifier: "struct",
  },
  c_sharp: {
    class_declaration: "class",
    interface_declaration: "interface",
    method_declaration: "method",
    struct_declaration: "struct",
  },
  ruby: {
    method: "method",
    class: "class",
    module: "type",
  },
  php: {
    function_definition: "function",
    method_declaration: "method",
    class_declaration: "class",
  },
  swift: {
    function_declaration: "function",
    class_declaration: "class",
    protocol_declaration: "interface",
  },
  kotlin: {
    function_declaration: "function",
    class_declaration: "class",
  },
};

/** Per-language call-site node types. Default covers TS/JS/Python/Go/Rust (current behavior). */
export const CALL_NODE_TYPES: Record<string, string[]> = {
  default: ["call_expression", "call"],
  java: ["method_invocation", "object_creation_expression"],
  c: ["call_expression"],
  cpp: ["call_expression"],
  c_sharp: ["invocation_expression", "object_creation_expression"],
  ruby: ["call"],
  php: ["function_call_expression", "member_call_expression", "scoped_call_expression"],
  swift: ["call_expression"],
  kotlin: ["call_expression"],
};

// C/C++ function_definition (and struct/pointer declarators) have no "name" field —
// the identifier is nested inside a "declarator" field chain, e.g.
// function_definition.declarator (function_declarator) .declarator (identifier).
// Walk the chain until we hit an identifier/field_identifier leaf.
function declaratorName(node: any): string | null {
  let cur = node.childForFieldName?.("declarator");
  while (cur) {
    if (cur.type === "identifier" || cur.type === "field_identifier") return cur.text ?? null;
    const next = cur.childForFieldName?.("declarator");
    if (!next) return null;
    cur = next;
  }
  return null;
}

// Extract the symbol name from a declaration node.
// For TS/JS: the first named child of type "identifier" or "property_identifier".
// We try childForFieldName("name") first (works in some grammars like Python/Go/Rust),
// then the C/C++ "declarator" chain, then fall back to scanning named children.
function nameOf(node: any): string | null {
  // Try field-based access (Python, Go, Rust grammars use "name" field)
  const byField = node.childForFieldName?.("name");
  if (byField) return byField.text ?? null;
  // C/C++ function_definition: name lives inside a nested "declarator" chain
  const byDeclarator = declaratorName(node);
  if (byDeclarator) return byDeclarator;
  // Fall back: first named child that is an identifier-like node
  // (Kotlin has no "name" field on function_declaration/class_declaration —
  // its identifier leaves are typed "simple_identifier"/"type_identifier".)
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const child = node.namedChild(i);
    if (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier" ||
      child.type === "simple_identifier"
    ) {
      return child.text ?? null;
    }
  }
  return null;
}

// Walk a subtree collecting call edges. No Query objects — plain node walk.
// kinds: the language's DECL_KINDS map — children whose type is a key in kinds
// are nested declarations that collect their own calls; skip descending into them.
function collectCalls(
  symbolNode: any,
  kinds: Record<string, string>,
  out: EdgeInput[],
  callTypes: string[],
): void {
  const stack: any[] = [];
  for (let i = 0; i < (symbolNode.namedChildCount ?? 0); i++) stack.push(symbolNode.namedChild(i));
  while (stack.length) {
    const n = stack.pop();
    if (kinds[n.type]) continue; // nested declaration → it collects its own calls
    if (callTypes.includes(n.type)) {
      // Prefer the grammar's "name" field first (e.g. Java's method_invocation.name),
      // then fall back to the first named child (TS/JS: identifier or member_expression).
      const byField = n.childForFieldName?.("name");
      const callee = byField ?? n.namedChild?.(0);
      if (callee) {
        // "identifier" covers TS/JS/Python/Go/Rust/C/C++; "name" is PHP's leaf type
        // for both function_call_expression (via namedChild(0)) and
        // member_call_expression (via the "name" field); "simple_identifier" is
        // Kotlin's leaf type (call_expression has no "name" field, falls to
        // namedChild(0)).
        if (callee.type === "identifier" || callee.type === "name" || callee.type === "simple_identifier") {
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

/**
 * A serializable AST declaration boundary — byte/line span of a declaration
 * node, suitable for postMessage across worker threads (plain data only,
 * no tree-sitter Node/Tree references). Used by the cAST chunker
 * (src/indexer/cast.ts) to derive chunk boundaries from real AST structure
 * instead of regex/brace-counting.
 */
export interface Boundary {
  name: string;
  kind: SymbolKind;
  start_index: number;
  end_index: number;
  start_line: number;
  end_line: number;
  /** Nesting depth among matched declaration nodes (0 = top-level). */
  depth: number;
}

// Walk the full AST and extract serializable declaration boundaries
// (byte offsets + line numbers), including nested declarations with their
// depth, so a chunker can recursively split an oversized parent via its
// children. Reuses the same DECL_KINDS map and name-resolution logic as
// extract() but tracks nesting depth and does NOT collect call edges.
export function extractBoundaries(tree: any, langId: string): Boundary[] {
  const kinds = DECL_KINDS[langId] ?? DECL_KINDS.typescript;
  const out: Boundary[] = [];
  const stack: Array<{ node: any; depth: number }> = [{ node: tree.rootNode, depth: 0 }];
  while (stack.length) {
    const { node: n, depth } = stack.pop()!;
    const kind = kinds[n.type];
    let childDepth = depth;
    if (kind) {
      const name = nameOf(n);
      if (name) {
        out.push({
          name,
          kind,
          start_index: n.startIndex,
          end_index: n.endIndex,
          start_line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1,
          depth,
        });
        childDepth = depth + 1;
      }
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      stack.push({ node: n.namedChild(i), depth: childDepth });
    }
  }
  // Boundaries must be in source order for the greedy chunker to work.
  out.sort((a, b) => a.start_index - b.start_index);
  return out;
}

// Walk the full AST and extract symbols with their call edges.
// Uses plain node iteration — no Query/cursor objects, nothing to leak.
export function extract(tree: any, langId: string, _source: string): SymbolInput[] {
  const kinds = DECL_KINDS[langId] ?? DECL_KINDS.typescript;
  const callTypes = CALL_NODE_TYPES[langId] ?? CALL_NODE_TYPES.default;
  const out: SymbolInput[] = [];
  const stack: any[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    const kind = kinds[n.type];
    if (kind) {
      const name = nameOf(n);
      if (name) {
        const edges: EdgeInput[] = [];
        collectCalls(n, kinds, edges, callTypes);
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
