// Ambient module declarations for Bun's `with { type: "..." }` import attributes.
// TypeScript's module resolution does not model Bun-specific import attributes,
// so `.wasm with { type: "file" }` and `.sql with { type: "text" }` imports are
// otherwise unresolvable (TS2307). Both attributes make Bun resolve the import
// to a string at runtime (a filesystem path for "file", the file's contents for
// "text") — see src/parser/languages.ts, src/parser/wasm.ts, src/graph/db.ts.

declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.sql" {
  const text: string;
  export default text;
}
