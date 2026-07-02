// src/parser/languages.ts
//
// Confirmed API (web-tree-sitter@0.25.10, tree-sitter-wasms@0.1.13):
//   import { Parser, Language } from "web-tree-sitter";
//   await Parser.init({ locateFile });          // see wasm.ts — core tree-sitter.wasm
//   const lang = await Language.load(wasmPath);
//   parser.setLanguage(lang);
//   const tree = parser.parse(source);       // returns Tree | null
//   tree.rootNode  -> SyntaxNode
//   root.type, root.namedChildCount, root.namedChild(n)?.type
//   tree.delete()  -> free WASM memory
//
// WASM SHIPPING: grammar .wasm files are imported with `{ type: "file" }`, NOT
// resolved via require.resolve. `bun build --compile` embeds these into the binary
// (the import yields a /$bunfs/... path at runtime); `require.resolve` would point
// at node_modules, which does not exist inside the shipped binary → the structural
// layer would crash. Dev runs resolve to the real node_modules path. See
// structural-layer/publish-blocker-wasm for the verified failure mode.

// Each unique grammar imported once (javascript serves both .js and .jsx).
import tsWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import jsWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import pyWasm from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import goWasm from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import rsWasm from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import javaWasm from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import cWasm from "tree-sitter-wasms/out/tree-sitter-c.wasm" with { type: "file" };
import cppWasm from "tree-sitter-wasms/out/tree-sitter-cpp.wasm" with { type: "file" };
import csWasm from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm" with { type: "file" };
import rubyWasm from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };
import phpWasm from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import swiftWasm from "tree-sitter-wasms/out/tree-sitter-swift.wasm" with { type: "file" };
import kotlinWasm from "tree-sitter-wasms/out/tree-sitter-kotlin.wasm" with { type: "file" };

export interface LanguageSpec {
  id: string;
  wasmPath: string;
}

export const LANGUAGES: Record<string, LanguageSpec> = {
  ".ts": { id: "typescript", wasmPath: tsWasm },
  ".tsx": { id: "tsx", wasmPath: tsxWasm },
  ".js": { id: "javascript", wasmPath: jsWasm },
  ".jsx": { id: "javascript", wasmPath: jsWasm },
  ".py": { id: "python", wasmPath: pyWasm },
  ".go": { id: "go", wasmPath: goWasm },
  ".rs": { id: "rust", wasmPath: rsWasm },
  ".java": { id: "java", wasmPath: javaWasm },
  ".c": { id: "c", wasmPath: cWasm },
  ".h": { id: "c", wasmPath: cWasm },
  ".cpp": { id: "cpp", wasmPath: cppWasm },
  ".cc": { id: "cpp", wasmPath: cppWasm },
  ".hpp": { id: "cpp", wasmPath: cppWasm },
  ".cs": { id: "c_sharp", wasmPath: csWasm },
  ".rb": { id: "ruby", wasmPath: rubyWasm },
  ".php": { id: "php", wasmPath: phpWasm },
  ".swift": { id: "swift", wasmPath: swiftWasm },
  ".kt": { id: "kotlin", wasmPath: kotlinWasm },
  ".kts": { id: "kotlin", wasmPath: kotlinWasm },
};

export function langForExt(ext: string): LanguageSpec | undefined {
  return LANGUAGES[ext];
}
