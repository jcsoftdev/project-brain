# Goal

Does the code still serve the goal it was written for? Codebases drift: the goal moves, the code does not, and nobody writes down the divergence. This module surfaces it.

## Stated goal

- [ ] Locate the goal as written — README opening, package description, ADRs, design docs. `search_code` the project name; `search_context` for "purpose" or "why". Where the README exists, confirm it states why the project exists, not only what it does and how to install it — a README that is entirely "what" and "how" with no "why" leaves the goal to be reconstructed from code, which is the condition the "no source states a goal" check below exists to catch; cross-reference it before scoring that check Medium. The "why" may live in a linked design doc or ADR the README points to rather than restating it — a link that resolves to a real doc satisfies this. (GitHub, Inc., "About READMEs" — https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes; Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10, 2020 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] If two sources state different goals, `search_code` each source's exact goal phrase to confirm both are current — rule out one being superseded by a changelog, deprecation note, or newer doc before calling it a live contradiction. A genuine contradiction is a `Medium` finding on its own. Pick neither; report both. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10, 2020 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] If no source states a goal, `search_code` "purpose", "goal", "mission" across the repo root and docs directory to confirm the absence rather than assume it. A project whose purpose exists only in someone's head cannot be onboarded onto.
- [ ] Where the stated goal makes a scoped, checkable-sounding claim ("fast", "offline-capable", "zero-config", "lightweight"), `search_code` for a corresponding threshold, benchmark, or default (a perf budget, a fallback branch, a counted config surface). A claim with nothing in the repo that could confirm or refute it is a goal this module cannot actually test — name it as untestable rather than silently skipping it. Rule out a claim that is qualitative by design (e.g. "developer-friendly") where the goal source itself frames it as aspirational rather than a measurable constraint — quote the goal source's own framing before calling it untestable. (re:Work (Google), "Set goals with OKRs" — https://rework.withgoogle.com/en/guides/set-goals-with-okrs)

## Goal vs. architecture

- [ ] The architecture serves the stated goal. `get_architecture` for the dependency list: a local-first tool with a hard cloud SDK dependency, a "simple" tool with a plugin system, a "fast" tool with a synchronous network call on the hot path — `find_callers` the hot-path function to confirm it is actually on a called-often path before flagging it. Each confirmed mismatch is a goal/structure defect.
- [ ] The highest-PageRank symbols from `repo_map` sit on the goal's critical path. If the centre of the call graph is infrastructure rather than the core job, the project may have drifted into building a framework.
- [ ] Constraints implied by the goal are actually enforced. "Offline-capable" — owned by `failure.md` (`search_code` for a fallback branch on an optional dependency's failure: cached data, a degraded path); reuse its finding when it ran, and add a goal-specific finding here only where the goal claims something that check didn't cover. "Zero-config" ⇒ `search_code` required config reads and count the keys with no default.

## Goal vs. scope

- [ ] Features that serve no stated goal. `find_callers` each major feature's entry point and check whether its purpose traces back to the stated goal. Not automatically wrong — but each needs a reason, or it is scope that will need maintenance forever. For a feature already flagged this way, run `impact` on its entry point before recommending removal: a small, self-contained blast radius is a maintenance-cost finding (Low); a blast radius reaching unrelated call paths is a coupling finding as much as a scope finding, and the recommendation changes from "remove" to "isolate first" — name which callers were excluded (e.g. test/mock code) before calling a large blast radius coupling. (Fowler, "Yagni," martinfowler.com bliki — https://martinfowler.com/bliki/Yagni.html)
- [ ] Goals with no supporting feature. Read the stated goal's claims one by one and `search_code` each for a corresponding entry point. The stated ambition nothing implements is usually the more expensive direction.
- [ ] Abandoned directions: half-built subsystems, feature flags never turned on, TODOs older than the last major refactor. `search_code` for `TODO`/`FIXME` and, where `Repo History` is in the confirmed module set, cross-check the comment's age against recent activity in that file. Cross-check flags with `Reachability`.

## Decision record

- [ ] Significant architectural choices have a recorded why — ADR, design doc, or at minimum a comment. `search_code` the decision's keyword (the technology or pattern name) across `docs/adr`, `docs/`, and the comments near its `find_symbol` location. An unexplained choice cannot be revisited safely because nobody knows what it was trading against. (ADR GitHub Organization, "Architectural Decision Records" — https://adr.github.io/; Nygard, "Documenting Architecture Decisions," Cognitect blog, 2011 — https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ ] Decisions that were reversed are recorded as reversed, not silently overwritten. `search_code` for an ADR or doc marked superseded; a reversal with no trace at all means the next person re-litigates a settled question. (ADR GitHub Organization, "Architectural Decision Records" — https://adr.github.io/; Nygard, "Documenting Architecture Decisions," Cognitect blog, 2011 — https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ ] Where a decision's rationale has expired (the constraint it optimised for is gone), flag it. Read the ADR/comment's stated constraint and check via `find_symbol`/`find_callers` whether the code that constraint drove is still present unchanged. That is the highest-value finding in this module.
- [ ] Where a `docs/adr/` (or equivalent) directory exists, `search_code` its most recent entry and compare its subject against `get_architecture`'s current dependency list and `repo_map`'s current top symbols. An ADR directory whose newest entry predates a dependency or architectural centre visible today is a decision-record practice that lapsed, not one that is healthy — record it as a distinct finding from "no ADR directory at all," since the two have different fixes. Check whether `get_architecture`'s dependency list or `repo_map`'s top symbols actually changed since that entry, not just whether time passed, before flagging. Where `Repo History` is in the confirmed module set, cross-check its findings to promote this past `inferred`.

## Out of static reach

- Whether the goal as stated is the *right* goal — that is a product judgement, not a static one.
- Whether an architectural mismatch actually causes pain in practice, versus being theoretically inconsistent.
- Team intent behind an undocumented decision, when no comment, ADR, or commit message records it.
- Whether a decision's original constraint has genuinely expired, when nothing in the repo dates the constraint itself.
- Whether a stated goal was understood by its authors as a firm commitment or an aspirational stretch — this module reads what was written, not how it was discussed.
- Whether the stated goal is genuinely aspirational or simply describes what the code already does — that judgement needs the team's own account, not the repo alone.
- Whether a recorded decision's stated context was complete and accurate at the time — this module can confirm a record exists, not that it told the whole story.
- Whether an unused feature's complexity tax has materially slowed real changes — this module measures coupling via `impact`, not historical change velocity.

## Severity guidance

| Situation | Severity |
|---|---|
| Architecture actively prevents a stated goal | High |
| Two sources state contradictory goals, both confirmed current | Medium |
| No goal recorded anywhere | Medium |
| Decision whose rationale has expired | Medium |
| Goal claim scoped and checkable-sounding but nothing in the repo can confirm or refute it | Medium |
| ADR/decision-record practice lapsed while the architecture kept moving | Medium |
| Feature serving no stated goal | Low |
| Abandoned direction still in the tree | Low |
| README states what and how but never why the project exists | Low |
