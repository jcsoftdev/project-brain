---
name: brain-commit
description: "Trigger: commit this, write the commit message, git commit, haz el commit, stage and commit, squash message, amend the message. Writes a commit message in the convention this repository already uses — conventional commits, gitmoji, or whatever the log actually shows — inferred from history rather than assumed."
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

Apply when a commit message is about to be written: a normal commit, an amend, a squash summary, or a PR title that must match the repo's style.

Do not apply when: the user dictated the exact message (write theirs verbatim), or the request is to explain history rather than add to it.

**The rule this skill exists to enforce: read the log before writing the message.** A repository already voted on its convention, dozens of times. Guessing "conventional commits" because it is popular produces a message that is wrong in a repo using gitmoji, and unreviewable in a repo using neither.

## Step 1 — Read the convention off the log

```bash
git log --no-merges --format=%s -n 100
```

Fewer than 100 commits is fine; a brand-new repo with zero is handled in Step 4. Also read a handful of full bodies, which is where the real house style lives:

```bash
git log --no-merges --format='%s%n%b%n---' -n 15
```

Classify the **subject lines** into one of four shapes:

| Shape | Looks like | Detection |
|---|---|---|
| Conventional | `feat(parser): add ESM support` | Matches `^(build\|chore\|ci\|docs\|feat\|fix\|perf\|refactor\|revert\|style\|test)(\(.+\))?!?: ` |
| Gitmoji | `✨ Add ESM support` or `:sparkles: Add ESM support` | Starts with an emoji or a `:shortcode:` |
| Gitmoji + conventional | `✨ feat(parser): add ESM support` | Both of the above, in that order |
| Freeform | `Add ESM support` | Neither |

**Decide by majority, and require a real majority.** If one shape covers ≥70% of the last 100 subjects, that is the convention — adopt it, including its details. Below 70%, treat the history as mixed and go to Step 4.

Count only what you can see. Do not weight by recency unless the split is clean — a repo whose last 30 commits are all gitmoji and whose first 70 are freeform has *changed* convention, and the recent one wins. Say so when you report the message.

## Step 2 — Read the details, not just the shape

The shape is the easy half. These are what make a message look native:

- **Scope vocabulary.** Extract the set of scopes actually used: `git log --format=%s -n 100 | rg -o '^\w+\(([^)]+)\)' -r '$1' | sort | uniq -c | sort -rn`. **Never invent a scope that has never appeared.** If your change does not fit an existing scope, omit the scope — that is always valid — rather than minting one.
- **Which gitmoji for which intent.** A repo using ✨/🐛/♻️/📝 consistently has a working vocabulary; reuse the emoji it already uses for that kind of change. Only reach for the full list at <https://gitmoji.dev/> when the change has no precedent in the log. Match the form: raw emoji (`✨`) and shortcode (`:sparkles:`) are not interchangeable — copy whichever the log uses.
- **Case and mood.** Lowercase or capitalized subject? Imperative ("add") or past ("added")? Copy the dominant one.
- **Trailing period.** Copy the dominant choice. Most repos omit it.
- **Subject length.** Match the observed median rather than a textbook 50 characters.
- **Body presence.** If most non-trivial commits carry a body, write one. If the log is subjects-only, do not start a new tradition unprompted.
- **Trailers.** Reuse only trailers that already appear (`Refs:`, `Closes #`, `BREAKING CHANGE:`). **Never add AI or co-author attribution unless the history already shows it** — introducing `Co-Authored-By` into a repo that has never used it is a visible, unrequested change to the project's record.

## Step 3 — Write the message about the change

Convention decides the *form*. These decide whether the message is worth reading:

- **The subject says what changed. The body says why.** The diff already shows what. A body that narrates the diff is noise; a body that explains the constraint, the bug's actual cause, or the rejected alternative is the reason anyone runs `git log` a year later.
- **Describe the change, not the process.** "fix flaky test" — not "address review feedback", "second attempt", or "as discussed".
- **One commit, one reason.** If an honest subject needs an "and", the work probably wants two commits. Say so; do not paper over it with a vague verb.
- **Breaking changes are marked**, in whatever way the repo marks them — `!` after the type, a `BREAKING CHANGE:` trailer, or both. Check the log for which.

## Step 4 — Edge cases, decided in advance

- **Empty history (the first commit).** No convention exists to infer. Default to **conventional commits** — it is the most widely tooled and the easiest to migrate away from — and tell the user this is a default, not a detection, so they can redirect once instead of forever.
- **Mixed history below the 70% bar.** Do not silently pick. State the split ("58% conventional, 31% freeform") and ask which to follow. A repo mid-migration is exactly where an assumed convention causes an argument in review.
- **A commit template is configured.** `git config commit.template` beats inference — the maintainers wrote it down on purpose. Read the file and follow it.
- **A committed config declares the convention.** `commitlint.config.*`, `.czrc`, `.commitlintrc*`, `.gitmojirc.json`, or a `commitizen` key in `package.json` are stronger evidence than any log sample, because they are enforced. Check for them before trusting the count; if one contradicts your inference, it wins.
- **Hooks may reject your message.** If `.husky/commit-msg`, `.git/hooks/commit-msg`, or a `lefthook`/`pre-commit` config exists, expect validation. On rejection, read the hook's rule and fix the message — never retry with `--no-verify` to get around it.

## Step 5 — Commit only what was meant

- **Commit what is staged.** If nothing is staged, say so and ask — do not `git add -A` on the user's behalf. An unrelated file swept into a commit is harder to undo than a missing one.
- **Check what you are about to commit** with `git diff --cached --stat` before writing the message. The message must describe *those* files. If secrets, build output, or a stray lockfile appear, stop and flag it.
- **Never amend or force-push a pushed commit** without the user explicitly asking. Rewriting shared history is not a message fix.

## Reporting back

State the convention you detected and the evidence, in one line, before or with the message:

> Detected: gitmoji + conventional (81/100 subjects). Scopes in use: `parser`, `cli`, `db`.

That one line is what lets the user correct a bad inference immediately, instead of discovering it in review. When you fell back to a default or hit a mixed history, say that too — a stated assumption is cheap, a silent one is not.
