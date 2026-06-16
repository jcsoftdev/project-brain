// src/parser/languages.ts
//
// Confirmed API (web-tree-sitter@0.25.10, tree-sitter-wasms@0.1.13):
//   import { Parser, Language } from "web-tree-sitter";
//   await Parser.init();
//   const lang = await Language.load(wasmPath);
//   parser.setLanguage(lang);
//   const tree = parser.parse(source);       // returns Tree | null
//   tree.rootNode  -> SyntaxNode
//   root.type, root.namedChildCount, root.namedChild(n)?.type
//   tree.delete()  -> free WASM memory

export interface LanguageSpec {
  id: string;
  wasmPath: string;
}

export const LANGUAGES: Record<string, LanguageSpec> = {
  ".ts": {
    id: "typescript",
    wasmPath: require.resolve(
      "tree-sitter-wasms/out/tree-sitter-typescript.wasm"
    ),
  },
  ".tsx": {
    id: "tsx",
    wasmPath: require.resolve("tree-sitter-wasms/out/tree-sitter-tsx.wasm"),
  },
  ".js": {
    id: "javascript",
    wasmPath: require.resolve(
      "tree-sitter-wasms/out/tree-sitter-javascript.wasm"
    ),
  },
  ".jsx": {
    id: "javascript",
    wasmPath: require.resolve(
      "tree-sitter-wasms/out/tree-sitter-javascript.wasm"
    ),
  },
  ".py": {
    id: "python",
    wasmPath: require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"),
  },
  ".go": {
    id: "go",
    wasmPath: require.resolve("tree-sitter-wasms/out/tree-sitter-go.wasm"),
  },
  ".rs": {
    id: "rust",
    wasmPath: require.resolve("tree-sitter-wasms/out/tree-sitter-rust.wasm"),
  },
};

export function langForExt(ext: string): LanguageSpec | undefined {
  return LANGUAGES[ext];
}
