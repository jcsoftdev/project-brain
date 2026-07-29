---
type: Gotcha
title: Language.load ignores Bun's /$bunfs virtual filesystem
description: Grammars must be loaded from bytes; passing a path silently disables every language in the compiled binary.
tags: [parser, bun, wasm, packaging]
resource: ../src/parser/wasm.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Symptom

The published binary parses nothing. No symbols, no call graph, so `find_symbol`,
`find_callers`, `impact` and `repo_map` all return empty. Every test stays green
and dev runs are perfectly healthy.

The only visible trace is one warning line:

```
[parser] grammar load failed for typescript: ENOENT: no such file or directory,
open '/$bunfs/root/tree-sitter-typescript-j0tgxqxy.wasm'
```

# Why

Grammar `.wasm` files are imported with `{ type: "file" }`, so `bun build
--compile` embeds them and the import yields a `/$bunfs/...` path at runtime.
Bun's own file APIs read that path fine:

```
Bun.file(tsWasm).exists()  → true
readFileSync(tsWasm)       → 2342690 bytes
```

But `Language.load(path)` hands the path to web-tree-sitter's emscripten loader,
which does its own file reading and never sees Bun's virtual filesystem.

Two things kept this invisible. `warm()` swallows grammar load failures by
design — a broken grammar must not take down the other languages — so the
failure degrades to a warning. And `bun test` runs from the project root, where
`node_modules` exists on disk, so nothing in the suite exercised the compiled
layout until a test compiled a real binary and ran it from a scratch directory.

# Fix

Read the bytes and pass those. One code path for both layouts:

```ts
const bytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
return Language.load(bytes);
```

`Parser.init({ locateFile })` for the *core* runtime wasm is unaffected and still
takes a path.

# How it was found

Compile a minimal probe with `bun build --compile` and compare, inside the
binary, `Bun.file().exists()` and `readFileSync()` against `Language.load(path)`
and `Language.load(bytes)`. Two steps isolate whether the asset is missing or
the reader is wrong — worth reaching for whenever a `/$bunfs` path 404s.

Related: [A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md).
