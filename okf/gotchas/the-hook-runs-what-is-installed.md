---
type: Gotcha
title: The hook and the MCP server run what is installed, not your working tree
description: Indexing changes have no effect on the live index until you reinstall — and the old binary actively overwrites what the new code wrote.
tags: [tooling, indexing, packaging, contributing]
resource: ../src/hooks/git.ts#installGitHook
sources:
  - resource: ../src/registrars/claude.ts#register
    title: Writes the MCP server command
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-30T00:20:00-05:00 }
---

# Gotcha

Two things write to this project's own index, and **neither runs your working
tree**:

- the post-commit hook, which invokes a bare `project-brain sync --changed-only`
  resolved through `PATH`
- the MCP server, registered as an absolute path to the installed binary

So editing indexing behaviour and running the tests proves the code is right and
changes nothing about what is actually in the index. Every commit keeps
re-indexing through the old artifact.

# Why it is worse than "no effect"

The stale binary does not sit idle — it writes. If your change altered how a file
is indexed, the old build **overwrites** the new result on the next commit, using
the same chunk ids.

That is exactly what happened to the OKF bundle. The routing that sends bundle
files through the curated projection was written, tested, committed, and correct.
The installed binary predated it, so every commit re-chunked the bundle as raw
markdown — frontmatter indexed as prose — and left `okf/log.md` in the index as
though a changelog were knowledge. Reading
[Concepts are keyed by their real repo path](/decisions/concepts-keyed-by-repo-path.md)
describes this collision as a code bug that was fixed; the same collision comes
straight back from a stale install, with nothing in the code to blame.

# The symptom to recognise

Source is green, tests prove the pipeline end to end, and the live index
disagrees anyway. Do not start debugging the pipeline. Check what the hook runs:

```sh
which project-brain
project-brain          # usage line lists the commands that build knows about
```

A usage line missing a command you added is the whole diagnosis. Nothing pins a
version and nothing warns on mismatch, so the only signal is the one you go
looking for.

# How to apply

- Reinstall after changing indexing, chunking, or routing behaviour. Until then
  the live index is evidence about the old build, not about your change.
- Verify from source instead of from the index: `bun src/cli.ts okf sync`,
  `bun src/cli.ts okf audit`. These run the working tree.
- Restart the MCP server after any CLI-side write. It holds its own LanceDB
  handle and keeps serving a pre-write snapshot until it reopens.
- Repairing a polluted index is a re-sync from source, not a code change — see
  [A skipped file keeps its chunks](/gotchas/a-skipped-file-keeps-its-chunks.md)
  for the one case where a re-sync alone was not enough.
