---
type: Decision
title: Staleness compares git commit dates, and the baseline is two dates
description: Filesystem mtimes break on clone; a declared attestation alone flags every freshly written concept as stale.
tags: [okf, audit, staleness, git]
resource: ../src/git/last-changed.ts
sources:
  - resource: ../src/okf/audit.ts
    title: findStale
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T20:50:00-05:00 }
---

# Decision

"Has the code changed since this explanation was written?" is answered with **git
commit dates**, never filesystem mtimes.

The baseline the code date is compared against is the **later of two** values:

1. the attestation the author declared (`verified[].at`, else `generated.at`), and
2. the commit date of the concept file itself.

Line-range precision comes from `git log -L <start>,<end>:<path>`, so editing an
unrelated part of a large file does not invalidate every concept citing it.

# Why not mtimes

`git clone` stamps every file with the checkout time. An mtime-based clock would
report every concept in the bundle stale the moment a teammate pulled it — a
100% false-positive rate for the second person to read the knowledge, which is
precisely the audience a shared bundle exists for. Commit dates live in the
history, so they mean the same thing on every machine.

# Why two dates and not just the declared one

Knowledge is normally written in the **same commit** as the code it explains.
The declared timestamp is therefore always slightly older than the commit that
carries both, so trusting it alone marks every fresh concept stale on the very
first audit.

It is also hand-written, and hand-written timestamps rot. This bundle proved it
within a day: the first six concepts were seeded with a placeholder
`2026-07-29T00:00:00Z` while the code they describe was committed at 12:14 the
same day. The first real audit reported four stale concepts. All four were
artifacts of a lazy placeholder, not drift.

The concept file's own commit date fixes both. It is objective, it lands in the
same commit as the code when the two are written together, and it moves whenever
anyone touches the note — including to re-attest it. Taking the LATER of the two
keeps the human signal authoritative: someone who re-reads a concept and updates
`verified` without otherwise editing the file still wins.

# Two silences that are deliberate

- **The concept file is uncommitted** → report nothing for it. The author is
  mid-edit; both sides are in flux and they are the one person who already knows.
- **Neither date exists** → report nothing. An unattested, uncommitted concept is
  an authoring gap, surfaced as `never attested`, not a staleness claim.

Uncommitted changes to the *code* are the opposite case and DO count as stale:
the commit clock cannot see them, so whatever date it returns describes older
code than what is on disk.

The concept's own path is resolved the same way its anchors are — see
[Anchors resolve from the bundle root](/decisions/anchors-resolve-from-the-bundle-root.md) —
so the same repo-relative key reaches git for both the note and the code it cites.

# How to clear a stale finding

Re-read the concept. If it still holds, add a `verified` entry; if it does not,
fix the prose. Either way the file changes and its commit date moves forward —
so simply editing the note honestly is enough, with no bookkeeping field to
remember to bump.
