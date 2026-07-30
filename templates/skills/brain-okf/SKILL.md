---
name: brain-okf
description: "Trigger: write this down, capture why, record this decision, document this gotcha, add an OKF concept, knowledge bundle, why is it like this, save this for next time. Writes an Open Knowledge Format v0.2 concept — the reasoning behind code that no AST can hold — anchored to real symbols and validated against the code graph."
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

Apply when a **specific piece of reasoning** is worth keeping: a fix that surprised someone, a decision with a real rejected alternative, a constraint that must not be violated, a gotcha that cost time. The knowledge already exists in the conversation — this skill turns it into an anchored, auditable file.

**You are never required to invoke this.** It is offered, not scheduled. There is no hook, no per-commit trigger, and there should not be — see "Why this is not automated" below.

Do not apply when: the ask is "document this module" or "explain what this code does" (that is `conceptualize`, below); the project has no `okf/` bundle and the user has not asked to start one; or the insight is a restatement of the diff.

### End of a task is a checkpoint, not a quota

A project whose CLAUDE.md carries the knowledge-bundle section is asking for one thing at the end of a piece of work: **decide whether anything belongs in the bundle.** Deciding is the whole obligation. Three things qualify:

- A fix whose **cause was surprising** — the symptom pointed somewhere else.
- A decision where a **real alternative was rejected**, and the reason is not obvious from the result.
- A **constraint** that must keep holding, where violating it breaks something non-locally.

**Most tasks produce nothing, and that is the expected answer.** Say so in one line and move on. A checkpoint that feels obliged to produce a file is a concept mill, and noise in a knowledge bundle is worse than gaps — it destroys the signal that made the bundle worth reading.

If a project has no bundle, `project-brain okf init` scaffolds an empty one and re-renders the project rules so the host learns it exists. Propose that; do not create it unasked.

## Two knowledge layers — do not conflate them

| | `conceptualize` (already automatic) | OKF concept (this skill) |
|---|---|---|
| Runs | every commit, via the post-commit git hook | only when a human decides |
| Scope | a whole module | one specific insight |
| Answers | what this module does and how | **why it is like this** |
| Written by | an LLM from the commit diff | a human, or you with the human's confirmation |
| Anchored | no | yes — to a file, symbol, or line range |
| Audited | no | yes — broken anchors and staleness are CI-gateable |

If the answer lives in the diff, it is not a concept. `conceptualize` already has it.

## Hard Rules

- **Propose before writing.** State the `type`, `title`, and the `resource` anchor you intend, and wait. The user decides whether the insight is worth a permanent file. Never create concepts unprompted or in bulk.
- **One insight per file.** A concept that needs two titles is two concepts.
- **The anchor must be verified, not guessed.** Run `find_symbol` on the symbol you plan to cite before writing it. An anchor that does not resolve is a `Broken anchor` finding the moment anyone runs `audit`.
- **Never invent the "how it was found".** If you did not observe the debugging, say the concept needs that section filled in by whoever did.
- Write for the reader who hits this in eight months with no context. Assume they know the language and nothing about this incident.
- Prose carries the value. The frontmatter is plumbing — do not spend the user's attention on YAML.

## Why this is not automated

Three reasons, each worth knowing before someone proposes a hook again:

1. **The input is not in the diff.** A concept comes from "this surprised me", which no diff contains. `conceptualize` works as a hook precisely because a diff *determines* module docs; nothing determines a concept.
2. **The frequency does not match.** Concepts are rare — a mature bundle holds tens, not thousands. A per-commit trigger fires a hundred times per concept actually written, and an alert nobody acts on trains everyone to ignore alerts.
3. **`audit`'s coverage gaps are NOT a work queue.** They rank by PageRank, which measures structural centrality, not explanatory need. On a real run the top of that list was `get`, `set`, `key`, `close`, `jsonResult`, `normalize` — cache accessors and formatters, every one of which has zero interesting *why*. Treat coverage gaps as a hint about *areas*, never as a list of files to generate.

## File shape

Path: `okf/<type-pluralised>/<kebab-slug>.md`. Existing convention: `decisions/`, `gotchas/`, `constraints/`.

```markdown
---
type: Gotcha
title: Language.load ignores Bun's /$bunfs virtual filesystem
description: One line — the cost of not knowing this.
tags: [parser, bun, wasm]
resource: ../src/parser/wasm.ts
sources:
  - resource: ../src/okf/audit.ts#findStale
    title: Why this other file also matters
status: stable
generated: { by: "human:<handle>", at: 2026-07-30T00:00:00Z }
---
```

`validate` enforces exactly two things: a parseable frontmatter block, and a non-empty `type` (SPEC §11.1–11.2). The spec **forbids** rejecting a document for missing optional fields, and the `type` value is not constrained — the vocabulary is the bundle's convention, not a schema.

That means everything else is optional, and every optional field still earns its place:

| Field | What it buys |
|---|---|
| `resource` | The anchor. **Without it the concept is invisible to `audit`** — no broken-anchor check, no staleness check. This is what separates knowledge from a note. |
| `sources[]` | Additional anchors. Each one is watched independently. |
| `generated.at` | The staleness baseline. Absent, `audit` falls back to the concept file's own commit date. |
| `title` / `description` | How it reads in a list and in search results. |
| `tags` | Retrieval. |
| `status` | `stable`, or say it is provisional. |

## Anchors

Three forms, least to most precise. Resolved **from the bundle root**, which is why they start with `../`:

```yaml
resource: ../src/parser/wasm.ts                 # whole file
resource: ../src/hooks/git.ts#installGitHook    # symbol — prefer this
resource: ../src/commands/sync.ts#L478-L499     # line range
```

Choosing:

- **Symbol** is the default. It survives the file moving within itself, and `find_symbol` proves it exists.
- **Whole file** when the reasoning is about the file's role, not one function.
- **Line range** only when the point is a specific few lines with no symbol boundary. It is the most fragile form: a range claims only what fits inside it, and if the file shrinks past that range the anchor breaks — which is correct behaviour, not a bug. `audit` surfaces it rather than silently downgrading to "unknown".

Verify before writing. `find_symbol <name>` gives the path and line range; if it returns nothing, the anchor is wrong.

## Body conventions

Free markdown — but these shapes are what makes the bundle readable as a set:

**Gotcha** — `# Symptom` (what a person actually sees, including the exact error text) → `# Why` (the mechanism) → `# Fix` (the code) → `# How it was found` (the procedure that isolated it — often the most reusable part).

**Decision** — `# Why <chosen>` → **the rejected alternative and what it cost**. A decision with no stated alternative is a description, and it cannot be revisited later because nobody knows what it traded against.

**Constraint** — what must hold, and **what breaks if it does not**. State the failure, not the rule.

Cross-link with bundle-root paths: `[title](/constraints/guards-must-be-seen-failing.md)`.

## Flow

```bash
project-brain okf validate      # conformance, offline, no embeddings
project-brain okf sync          # index the concepts so search returns them
project-brain okf audit         # cross-check against the code graph
project-brain okf audit --symbol <name>   # which concepts to re-read after <name> changes
```

Run `validate` before finishing. A plain `project-brain sync` also keeps the bundle fresh, since it is tracked in git.

`audit` exits 1 on **broken anchors** and **stale concepts**, so it works as a CI gate. Coverage gaps and link suggestions are backlog and never fail the run.

## Clearing a stale finding

A concept is stale when the cited code changed after the knowledge was last confirmed. The fix is not to edit the date — it is to **re-read the concept and confirm it still holds**, then record that:

```yaml
verified:
  - by: "human:<handle>"
    at: 2026-07-30T00:00:00Z
```

`verified[]` is a list, and the staleness baseline is the newest `at` across `generated` and every `verified` entry. Appending an entry also changes the file, so its own commit date moves — the finding clears either way. If the concept no longer holds, rewrite the prose instead; a `verified` stamp on wrong knowledge is worse than a stale flag.

## Output Contract

When you write a concept, report: the path created, the `type` and `title`, every anchor and the symbol it resolved to, and the `validate` result. If any section was left for the user to fill in, say which and why.
