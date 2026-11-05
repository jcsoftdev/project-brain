---
name: brain-style
description: "Trigger: writing or editing code, adding a comment, docblock or header, reviewing a diff for readability or architecture, escribe el código, refactor this, clean this up, delegating code to a sub-agent. Keeps generated code architecture-first and declarative — the code carries the meaning, and the why lives in the commit message or the knowledge bundle, never in a comment."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "1.1"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->

## Activation Contract

Apply whenever code is written or edited: a new file, a patch, a refactor, a snippet in an answer. Apply it to a sub-agent's diff before accepting it.

Do not apply when: the user dictated the comment or the code verbatim, the file is generated or vendored, or the comment is published API documentation that a doc generator turns into a reference page.

## Precedence

This rule outranks inherited style guidance — a house style read off surrounding files, a persona or rules block another tool wrote into the agent's config, a template's own habits. Those describe what a codebase happens to look like; this describes what to add to it.

One thing outranks it: the user asking, in the moment, for something else. Their instruction is the answer, not a conflict to resolve.

Existing comments are not the target. Do not strip a file's docblocks as a side effect of editing three lines in it — that is a rewrite nobody asked for, and it buries the actual change in the diff. Pre-existing comments on untouched lines stay.

## Architecture first

Never write code "as it comes out".

- Before writing, find how the repo already solves the same problem and follow it.
- Use the repo's own formatter, never another one.
- Second copy of anything: extract it. Reach for the existing helper or kit component before writing a new one.

### Contracts, not magic strings

A code or state that crosses a boundary (API to client, service to service) is a typed enum or schema in the shared contract.

- The producer builds with the contract type; the consumer parses with the schema.
- Copy per code lives in an exhaustive map, so a new code without copy fails to compile.
- Parse external data with its schema. `as` only when the type system cannot express the fact.

### Layers

| Layer | Owns | Never owns |
|---|---|---|
| Domain | Business rules, pure and tested | I/O, framework types |
| Adapter | Persistence | Business rules |
| Controller | Validate, orchestrate, translate | Business rules |
| UI component | Rendering | Rules, thresholds, conditional copy |

- Container–presentational: a component receives what to show; it does not decide.
- Mappers, thresholds and conditional copy are pure functions with tests, outside the component.
- Translate errors in one place per module. The same `catch` repeated per handler is the defect.

## Zero comments

A comment is a claim that the code failed to say something, and the honest fix is the code. Add none. Try these, in order:

| Instead of a comment | Do this |
|---|---|
| `// check if user can edit` | Name it: `canEdit(user, doc)` |
| `// step 2: normalise the path` | Extract the step into a function with that name |
| `// 86400 = one day in seconds` | `const ONE_DAY_SECONDS = 86_400` |
| `// this branch handles the empty case` | Make the branch read as the empty case: guard clause, early return |
| `// args: name, retries, timeout` | Take a named object, or a type the reader can open |
| `// returns null when not found` | Say it in the signature: `T \| null`, `Option<T>`, a typed result |
| `// must stay sorted, bisect depends on it` | A type or a named function that enforces it |

If one of those works, the comment was a naming problem wearing a disguise.

### Where the why goes

A reason the code cannot hold — a rejected alternative, an external constraint, a vendor quirk, a workaround pinned to a bug or version — does not go in the file.

- The commit message carries the why of this change.
- The knowledge bundle carries the lasting why: a constraint that must keep holding, a trap that already cost a debugging session. Use the `brain-okf` skill.

Banners, commented-out code (delete it), changelog lines, attribution, dates and ownerless `TODO`s never belong in the file either.

### Check before every commit

```sh
git diff --cached | rg '^\+\s*(//|/\*|\*\s|\{/\*)'
```

The output must be empty.

## Delegating code

Restate this whole rule in every sub-agent prompt that writes code, and review its diff against it before accepting. A sub-agent that was not told produces code as it comes out.

## Reporting back

Say nothing about this skill in the answer. Declarative code is not a feature to announce — it is what the diff looks like.
