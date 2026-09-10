---
name: brain-style
description: "Trigger: writing or editing code, adding a comment, docblock or header, reviewing a diff for readability, escribe el código, refactor this, clean this up. Keeps generated code declarative — the code carries the meaning, and a comment appears only where it says something the code cannot."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "1.0"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->

## Activation Contract

Apply whenever code is written or edited: a new file, a patch, a refactor, a snippet in an answer.

Do not apply when: the user dictated the comment or the code verbatim, the file is generated or vendored, or the comment is published API documentation that a doc generator turns into a reference page.

## Precedence

This rule outranks inherited style guidance — a house style read off surrounding files, a persona or rules block another tool wrote into the agent's config, a template's own habits. Those describe what a codebase happens to look like; this describes what to add to it.

One thing outranks it: the user asking, in the moment, for something else. Their instruction is the answer, not a conflict to resolve.

Existing comments are not the target. Do not strip a file's docblocks as a side effect of editing three lines in it — that is a rewrite nobody asked for, and it buries the actual change in the diff.

## The rule

**Default: no comment.** A comment is a claim that the code failed to say something, and most of the time the honest fix is the code.

Before writing one, try these, in order:

| Instead of a comment | Do this |
|---|---|
| `// check if user can edit` | Name it: `canEdit(user, doc)` |
| `// step 2: normalise the path` | Extract the step into a function with that name |
| `// 86400 = one day in seconds` | `const ONE_DAY_SECONDS = 86_400` |
| `// this branch handles the empty case` | Make the branch read as the empty case: guard clause, early return |
| `// args: name, retries, timeout` | Take a named object, or a type the reader can open |
| `// returns null when not found` | Say it in the signature: `T \| null`, `Option<T>`, a typed result |

If one of those works, the comment was a naming problem wearing a disguise.

## What earns a comment

Three things, all of them the *why* — never the *what*:

- **A reason the code cannot hold.** A rejected alternative and why it lost, an external constraint, a spec or vendor quirk that makes correct code look wrong.
- **An invariant that breaks non-locally.** "This must stay sorted, `bisect` downstream depends on it." The reader cannot see the downstream from here.
- **A workaround pinned to something external.** Name the bug, version, or ticket, so the next person can tell whether it is still needed.

Write those in full sentences. They are for a reader a year out with no memory of this week.

## What never earns one

- Restating the line below it.
- Section banners (`// ---- helpers ----`) — that is a file asking to be split.
- Commented-out code. Delete it; that is what version control is for.
- Changelog, attribution, or a date. The log holds those, and it stays accurate.
- A `TODO` with no owner and no condition. Either it blocks and belongs in an issue, or it does not and belongs nowhere.

## Reporting back

Say nothing about this skill in the answer. Declarative code is not a feature to announce — it is what the diff looks like.
