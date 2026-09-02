# Repo History

What does the commit log reveal that the working tree cannot? Gate: the project is a git repository.

`security.md` has one reactive line: check history when a secret turns up in the working tree. This module is the proactive counterpart — it reads history whether or not anything is currently wrong, because churn, ownership, and buried secrets are findings on their own. **Narrow execution exception**: this is the one module in the skill permitted to run commands, and only four — `git log`, `git rev-list`, `git ls-files`, `git cat-file`, together with their strictly read-only siblings (`git branch -a`, `git tag`, `git shortlog -s -n`) for enumerating refs and authors. None of these mutate the repository. State this exception is unique to this module; no other reference file may use it. **A shallow clone makes every check below `undetermined`, not `not applicable`** — a shallow history has already discarded the evidence, and reporting the check as clean would be wrong in the specific way this skill exists to prevent.

## Shallow-clone check (run first)

- [ ] Confirm the clone is complete before trusting any result below — `git rev-list --count HEAD` compared against the commit count the remote reports, or the presence of a `.git/shallow` file. Every check in this module downgrades to `undetermined` on a shallow clone, not `not applicable`.

## Secrets and sensitive data

- [ ] Secrets removed from HEAD but still present in history. `git log -p -S'<pattern>'` (the pickaxe search) for known secret shapes — `AKIA`, `-----BEGIN`, `sk_live_`, a `.env` file that was ever committed then later deleted. A hit means rotation is required regardless of what HEAD looks like today; removal from HEAD does not remove it from any clone already made.
- [ ] `.gitignore` gaps proven by tracked files, not assumed from the ignore file's intent — `git ls-files` and check the output for `.env`, `*.pem`, `credentials.json`, local IDE config, or a build-output directory that should never have been tracked.

## Repository weight

- [ ] Large blobs sitting in history whether or not they are still in HEAD. `git rev-list --objects --all` piped to `git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'`, sorted by size. A binary removed from HEAD still weighs on every fresh clone forever unless the history itself is rewritten.
- [ ] Generated or vendored artefacts committed at any point (build output, `node_modules`, lockfile-generated files committed alongside source) — Read the large-blob list above against file extensions that should be build products, not source.
- [ ] The same large asset re-committed repeatedly under a changing name or path (`asset-v1.psd`, `asset-v2.psd`) — each version is a permanent addition to history weight even after the file is later deleted, and `git rev-list --objects` will show every one of them as distinct, undeletable objects.

## Churn as a risk map

- [ ] Highest-churn files across the project's life — `git log --all --pretty=format: --name-only` and tally frequency by path. The code that changes most is where defects concentrate; a file with disproportionate churn relative to its size is worth a closer look regardless of what it does.
- [ ] Cross-reference that churn ranking against `repo_map`'s structural (PageRank) ranking. A file that is both high-churn and structurally central is the highest-risk file in the repository, and the overlap is not visible from either ranking alone.
- [ ] Commits touching an implausible number of files in one change — `git log --format=%H --shortstat`, looking for outliers well above the commit-size norm the rest of the log establishes. A 400-file commit is not reviewed the way a 4-file commit is, whatever the message claims.

## Ownership and bus factor

- [ ] For files identified as high-churn or structurally central, the distinct set of authors — `git log --follow --format=%an -- <path>`, deduplicated. A file touched by exactly one author across its entire life is a bus-factor finding independent of how good that author is.
- [ ] Compare author concentration on critical-path files against the project's overall author list (`git shortlog -s -n`). A file maintained by one person in a project with ten contributors is a different risk than the same pattern in a two-person project.

## Commit hygiene

- [ ] Commit message convention — read a sample of `git log --format=%s` and determine whether the log already follows one (Conventional Commits, a ticket-prefix convention, or none at all), then flag messages that break the majority pattern the log itself establishes. Do not import an external convention the project never adopted.
- [ ] TODO/FIXME age measured from the commit that introduced the line, not assumed from when it was last read — `git log -S'TODO' --follow -- <path>` (or `-G` for a regex match) to find the introducing commit and its date. A comment's age is evidence; a guess at its age is not.
- [ ] Stale branches — `git branch -a` (or `--no-merged`) for branches with no recent activity and no open path to being merged. Use no commit in the last 6 months as the default staleness threshold, or the project's own documented one if it states a shorter/longer window. Each one is either abandoned work or work nobody remembered to land.
- [ ] Tags left behind with no corresponding release artefact, or a release process that no longer produces the tags it once did — `git tag` against the release workflow's tagging step.
- [ ] Ratio of non-descriptive commit messages (`wip`, `fix`, `temp`, `asdf`, single words) against the log's total — sample `git log --format=%s` and quantify rather than citing an anecdote or two. A handful is normal; a third of the log is a process gap.
- [ ] Frequency of revert commits — `git log --all --grep='^Revert'` (or the project's own revert convention). Use more than 3 reverts on one path in 3 months as the default threshold for a steady trickle rather than an anomaly — instability the churn ranking alone will not surface, because a revert and its original commit both count as ordinary churn.

## History rewrite evidence

- [ ] Evidence of a force-push or history rewrite that was not communicated — `search_code` `README`, `CONTRIBUTING`, or `CHANGELOG` for any note about a rewritten history (squash, author-scrub, secret purge), and treat an unexplained gap or a sudden un-followable `--follow` chain on a file as a signal worth naming, not proving. **Falsify before flagging**: a repository imported from another VCS or squash-merged by convention will show the same shape without anything having gone wrong — confirm which explanation fits before reporting either way.

## Out of static reach

- Whether a secret found in history has already been rotated — the audit can prove exposure, not remediation status.
- Reflog entries and any commits genuinely orphaned by a rewrite — a fresh or shallow clone has already lost this evidence, and it cannot be reconstructed from what remains.
- Author identity beyond the name/email recorded in the commit — a shared machine or CI bot account can misattribute ownership.
- Whether a high-churn file's churn reflects real defect density or an unrelated cause (generated file, formatter re-run, mass rename) — the ranking is a prioritisation signal, not a verdict on its own.

## Severity guidance

| Situation | Severity |
|---|---|
| Live secret found in history, not present in HEAD | High |
| Secret present in HEAD and in history — defer to `security.md`'s traced Critical when its `find_callers` probe shows the literal reaching a live client/service constructor; otherwise | High |
| Tracked file that should be gitignored and carries credentials | High |
| File both high-churn and structurally central, single author | High |
| Commit touching an implausible file count with no review trail | Medium |
| Large binaries committed and still weighing on every clone | Medium |
| Stale branches with no merge path | Low |
| TODO/FIXME meaningfully older than its surrounding code | Low |
| Commit message convention established but occasionally broken | Low |
| No commit message convention discernible from the log at all | Info |
