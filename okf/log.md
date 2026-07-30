# Knowledge Update Log

## 2026-07-30
* **Creation**: [A skipped file keeps its chunks](/gotchas/a-skipped-file-keeps-its-chunks.md) —
  found by running the new cross-graph audit against this bundle: `log.md` itself
  was in the vector index, orphaned by the OKF routing that skips it.

## 2026-07-29
* **Creation**: Bundle seeded from the OKF v0.2 support work — the three traps
  found while building it and the decisions that shaped its scope.
* **Creation**: [The bundle is not a mirror of the code graph](/decisions/knowledge-not-a-code-mirror.md).
* **Creation**: [Concepts are keyed by their real repo path](/decisions/concepts-keyed-by-repo-path.md).
* **Creation**: [A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md).
* **Creation**: [Language.load ignores Bun's /$bunfs](/gotchas/language-load-ignores-bunfs.md).
* **Creation**: [new Worker() can throw synchronously](/gotchas/worker-constructor-throws.md).
* **Creation**: [mockRejectedValueOnce rejects eagerly](/gotchas/mock-rejected-value-is-eager.md).
* **Creation**: [Staleness compares git commit dates, and the baseline is two dates](/decisions/staleness-baseline-is-two-dates.md).
* **Creation**: [The coverage backlog skips tests, and nothing else does](/decisions/coverage-backlog-skips-tests.md).
* **Creation**: [Anchors resolve from the bundle root, not from the document](/decisions/anchors-resolve-from-the-bundle-root.md).
* **Creation**: [git log -L errors when the range runs past the end of the file](/gotchas/git-log-L-fails-past-end-of-file.md).
* **Update**: [A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md) —
  added "break one thing at a time" after five simultaneous breaks masked each
  other, and the note that a negative test is only as strong as its positive twin.
