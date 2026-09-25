---
type: Gotcha
title: Writes must embed with the table's model, not the server's default
description: One write with a different embedding width drops and recreates the project's table, and a manifest that outlives it hides most of the repository from search with no error.
tags: [embeddings, store, sync, manifest, indexing]
resource: ../src/tools/ingest.ts#handleIngest
sources:
  - resource: ../src/store/lancedb.ts#ensureTable
    title: Recreates the table when the incoming dimension differs
  - resource: ../src/serve.ts#maybeStartWatcher
    title: The watcher is the other write path that used the default model
  - resource: ../src/commands/sync.ts#runSync
    title: The self-heal that re-adds files when the store falls behind the manifest
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-25T18:00:00-05:00 }
---

# Symptom

Search quality looks bad, not broken. Queries that name a symbol exactly miss the
file that defines it; `search_code "hybridSearch"` did not return
`src/store/lancedb.ts`. Nothing fails and nothing logs. `project-brain health`
reported `Chunks: 382` and a green check, while the repository's manifest listed
3389 chunks. The retrieval bench scored recall@10 25.9%. After a `reindex` the
same queries scored 95.2%.

# Why

A project's LanceDB table is built at one embedding width: `qwen3-embedding:0.6b`
is 1024. `ensureTable` treats a different incoming width as a model change and
drops the table, then recreates it.

The server's default embedding client follows whatever Ollama has installed at
startup. When `qwen3-embedding` is missing, the factory falls back to
`nomic-embed-text`, which is 768. `add_knowledge`, `manage_adr` and the file watcher
embedded with that default instead of the project's model, so one knowledge note
was enough to wipe the table.

The per-repo manifest (`.project-brain/manifest.db`) lives somewhere else, and it
survived. Every later `sync` compared file hashes against it, found them
unchanged and skipped them. The table only regained the files edited after the
wipe. Everything else stayed invisible indefinitely. This is the same family as
[a skipped file keeps its chunks](/gotchas/a-skipped-file-keeps-its-chunks.md):
the manifest records what was handled, not what the store holds.

# Fix

- Every write path embeds through `embeddingsFor(project)`, which resolves the
  model recorded for that project's table, never `deps.embeddings`.
- `runSync` calls `ensureTable` first. When the store has fewer rows than the
  manifest has chunks, it logs one line, clears the manifest and walks every file
  again. That also covers the paths that can still drop the table: `init`, `prune`
  and `delete_project`.
- `health` prints `Chunks: N (manifest: M)` and warns when the store is short.

A new write path must resolve its embedding client per project. The default
client is only safe for reading.

# How it was found

The retrieval bench (`project-brain bench`) scored far below expectation.
Comparing the newest mined commits against the oldest first suggested temporal
drift. Then an exact identifier query missed the file that defines it. Counting
rows exposed the gap: `project_brain_chunks` had 0 rows for `src/store/lancedb.ts`
while the manifest had 17.

The table's LanceDB version history (`listVersions`) started on 2026-09-21 at
17:20:05 with a fresh create, and afterwards only grew through small syncs. The
first real row had an id in `add_knowledge`'s `source::hash8` form, not sync's
form. Its `updated_at` was 115 ms before the table was created, which matches
`handleIngest`'s order: embed, then ensure the table. There were no commits that
day.
