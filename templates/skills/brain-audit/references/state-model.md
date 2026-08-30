# State Model

Does every declared state get reached, and does everything that reads it agree on what it means? Gate: enumerated states, a status column, or a state library was detected.

This module audits explicit state machines and status fields — the enum, the `status` column, the state chart — as data. It does **not** own how a flow gets wired to UI events or navigation; that is `flow-integrity.md`. It does **not** own where a React component's or a store's state lives, or whether it is over- or under-lifted; that is `frontend.md`. If a check here starts asking "who calls `setState`", it belongs in one of those two instead.

A formal state model — a statechart, in Harel's original sense, standardised by the W3C as SCXML (a Recommendation since September 2015) and popularised in the JS ecosystem by XState — gives a codebase something a flat enum plus `switch` cannot express on its own: hierarchical (nested) states for sub-states that only carry meaning inside a parent, orthogonal/parallel regions for independent facets of status varying at once without a combinatorial cross-product enum, and a transition table where an edge must exist for a move to be legal at all, rather than any state being reachable from any other just because a write path didn't check. Every check below is, in effect, asking whether the codebase's enum-plus-switch is honouring guarantees a real state machine would have enforced structurally.

## Enumerate the state set

- [ ] Find every declaration of the state set: an enum, a union type, a database column's `CHECK` constraint or comment listing valid values, a state-machine library's chart definition (XState, a `transitions` table). `find_symbol` on the type/enum name to get the canonical list.
- [ ] Find every place that switches on it: `find_callers` on the enum/type, then read each `switch`/`match`/if-chain for completeness against the list above.
- [ ] Note the state set's shape once, in prose, so every later check has a fixed reference — this is the yardstick, same discipline as establishing the token vocabulary in `design-system.md`.

## Declared but unreachable

- [ ] A state present in the enum that no code path ever assigns. `search_code` the state's literal value as an assignment target (`status = 'archived'`, `.setState(Status.Archived)`); if nothing assigns it, it is dead data, not dead code — cross-reference `reachability.md` for the mechanics but report the finding here since the enum is the artefact.
- [ ] A state assigned only in a test fixture or seed script, never by application logic — the same shape, one layer removed.

## Assigned but unhandled

- [ ] The inverse and more dangerous gap: a state that gets assigned somewhere but that a `switch`/`match` elsewhere doesn't handle. Read each switch site found via `find_callers` above for a **missing `default`/`else` arm** — code that silently falls through and does nothing is worse than a crash, because nothing signals the gap ever fired.
- [ ] `search_code` for the exhaustiveness marker itself (`: never`, `assertNever(`, `@Exhaustive`, a sealed-class `when` in Kotlin). Its absence at a switch site is exactly what let the current gaps exist, and adding it is the fix that prevents the next one. Cross-reference `type-safety.md` if the exhaustiveness gap is hidden behind an `any`/suppressed cast.
- [ ] Among the switch sites read above, a `default`/`else` arm that maps every unrecognised state to some fallback value rather than erroring or logging — a milder form of the same gap: it hides a genuinely unhandled state behind output that looks intentional, so nobody notices the switch was incomplete.
- [ ] Every creation path (constructor, insert, factory function) assigns one of the declared states explicitly. `search_code` the record's construction sites; a field left `null`/undefined at insert time behaves as a phantom extra state that no switch was written to handle.

## Transitions

- [ ] Every transition path is deliberate: `trace_path` (or a straightforward read of the transition table) from each state to the states it's allowed to reach. A transition with no guard — any state can jump to any other by just setting the field — is not a state machine, it's a label.
- [ ] Transitions that skip a declared intermediate state. If the model says `draft → review → published`, `search_code` every write site setting `published` directly (`status = 'published'`, `.setState(Status.Published)`) and check its originating state — confirm any direct `draft → published` write is intentional (an admin override) rather than a bypass nobody meant to allow.
- [ ] Terminal states with a way out that shouldn't exist — `search_code` for a write to the state field inside any code path reachable after a `cancelled`/`refunded`/terminal check, e.g. `if (status === 'cancelled') { ... status = ... }`.
- [ ] Non-terminal states with no path forward at all: cross-check the transition table built above — any state that appears as a **target** of some transition but never as a **source** of one. Records land there and stay forever. Rule out first: a manual/support-only transition that's real but undocumented in code (an admin panel, a direct DB fix) — state which you checked.

## Duplicated state sets

- [ ] The same conceptual state set declared twice — a backend enum and a frontend union, a database `CHECK` constraint and a client-side type — and already out of sync. Diff the literal member lists; a backend value with no frontend counterpart renders as `undefined`/a blank label, not an error. **Cross-reference `cross-surface-parity.md`**, which owns diverged behavioural rules between surfaces; this module reports the divergence, that module tracks the general pattern.
- [ ] Where a shared type is meant to be the single source, `search_code` the second surface's directory for a local re-declaration of the same enum/union name rather than an import from the shared location — a local copy that happens to match today is the drift waiting to happen.

## Persisted values the code no longer knows about

- [ ] Values existing in stored data (a `status` column, a serialized state field) that don't appear in the current enum at all — the fingerprint of a state renamed or removed without a data migration. `search_code` for the old name in migration history or a comment; if the current switch has no case for it, every row carrying that value falls through the unhandled-state gap above, silently, in production, for real records.
- [ ] `search_code` migration files for an `ALTER`/`CHECK`-constraint change to the state column with no accompanying `UPDATE` statement backfilling the old values to a valid new one.

## Concurrency on transitions

- [ ] `search_code` each transition function found above for a read-then-write shape (fetch the record, check its current state, then write the new one) with no atomic guard — optimistic lock, unique constraint, or conditional `UPDATE ... WHERE status = ...`. Two concurrent requests (a double-submit, a webhook retry) racing this gap will both pass the check and both write. Cross-reference `concurrency.md`'s read-modify-write section; report the state-specific instance here.
- [ ] A self-transition (a record transitioning back into the state it's already in) unintentionally re-firing side effects — a confirmation email, a webhook, a billing event — that were meant to fire once on entry. `find_callees` on the transition handler to see what it triggers, then check whether it guards on "value actually changed" before triggering them.

## Display and downstream consumers

- [ ] `search_code` the label/badge/translation lookup that renders the state to a user and diff its case list against the canonical enum from the first section. A state with no display case renders a blank, the raw enum key, or throws, depending on the language's default behaviour for an unmatched case.
- [ ] `search_code` filter and sort UI (a dashboard's status filter, a report's grouping control) for a hardcoded local list of state values, and diff it against the canonical enum — a state added later silently never appears as a filter option, and records in it become invisible to anyone filtering.

## Out of static reach

- Whether an admin-only or support-tooling transition is intentional versus a bypass — usually needs a person to confirm.
- The actual frequency a given transition fires in production, which decides how urgent an unguarded race really is.
- Whether a "stuck" non-terminal state is a real dead end or one only reachable through an out-of-repo system (a support queue, a manual ops runbook).

## Severity guidance

| Situation | Severity |
|---|---|
| Persisted value with no current code path that handles it | Critical |
| Assigned state with no handling branch (silent no-op) | High |
| Transition with no guard, reachable from any state | High |
| Non-terminal state with zero outgoing transitions | High |
| Same state set duplicated across surfaces and diverged | High |
| Transition skipping a declared intermediate state | Medium |
| Terminal state with an unintended exit path | Medium |
| Missing exhaustiveness check on a state switch | Medium |
| Declared state never assigned by any code path | Medium |
| Race on a transition with no atomic guard | Medium (High if it double-charges/double-ships) |
