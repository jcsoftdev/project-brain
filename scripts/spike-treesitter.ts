// scripts/spike-treesitter.ts
// WASM spike gate: prove web-tree-sitter loads a grammar in Bun before any
// further parser work proceeds. Must print SPIKE_OK with a non-empty AST.
import { Parser, Language } from "web-tree-sitter";

const TS_WASM = require.resolve(
  "tree-sitter-wasms/out/tree-sitter-typescript.wasm"
);

async function main() {
  await Parser.init();
  const parser = new Parser();
  const lang = await Language.load(TS_WASM); // line that historically threw getDylinkMetadata
  parser.setLanguage(lang);
  const tree = parser.parse(
    "export function add(a: number, b: number) { return a + b; }"
  );
  const root = tree!.rootNode;
  console.log("ROOT_TYPE:", root.type);
  console.log("CHILD_COUNT:", root.namedChildCount);
  console.log("FIRST_NAMED:", root.namedChild(0)?.type);
  tree!.delete();
  console.log("SPIKE_OK");
}

main().catch((e) => {
  console.error("SPIKE_FAIL", e);
  process.exit(1);
});
