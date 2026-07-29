---
okf_version: "0.2"
---

# project-brain knowledge

Curated knowledge for this repository, in [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) v0.2.

This bundle holds what the code cannot say about itself: why a thing is built the
way it is, which constraints must keep holding, and the traps that already cost
someone a debugging session. It deliberately does **not** describe what the code
*is* — symbols, call graphs and line ranges are answered by `find_symbol`,
`find_callers` and `impact`, faster and never stale. See
[The bundle is not a mirror of the code graph](/decisions/knowledge-not-a-code-mirror.md).

## Concept types

| Type | Answers |
|------|---------|
| `Decision` | why this way and not the obvious alternative |
| `Constraint` | an invariant that must keep holding |
| `Gotcha` | a trap that already cost us once |

## Decisions
* [The bundle is not a mirror of the code graph](/decisions/knowledge-not-a-code-mirror.md) - what belongs in here, and what must never.
* [Concepts are keyed by their real repo path](/decisions/concepts-keyed-by-repo-path.md) - why the ingest shares ids with the regular indexer.

## Constraints
* [A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md) - a green test proves nothing until you watch it go red.

## Gotchas
* [Language.load ignores Bun's /$bunfs](/gotchas/language-load-ignores-bunfs.md) - why grammars load from bytes.
* [new Worker() can throw synchronously](/gotchas/worker-constructor-throws.md) - why candidate fallback needs a try/catch.
* [mockRejectedValueOnce rejects eagerly](/gotchas/mock-rejected-value-is-eager.md) - why an added await breaks the mock, not the code.
