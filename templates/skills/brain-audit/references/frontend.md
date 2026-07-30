# Frontend

Client-side structure and correctness. Gate: a UI framework was detected.

Family B does the wiring work — orphan handlers and the loading/empty/error triad live in `flow-integrity.md`. Do not duplicate them here; cross-reference.

## Component structure

- [ ] Components separate what they show from where the data comes from. A component that fetches, transforms, and renders has three reasons to change.
- [ ] No component is large enough that its responsibilities cannot be named in one sentence. Find the biggest ones via `repo_map`.
- [ ] Shared UI is shared, not copy-pasted. `search_code` a distinctive class name or string from a component to find its duplicates.
- [ ] Props are typed, and optional props have defaults at one place rather than at each call site.

## State

- [ ] Each piece of state has one owner. State duplicated in two places will diverge.
- [ ] Server data and UI state are distinguishable. Caching server data in the same store as ephemeral UI flags makes invalidation guesswork.
- [ ] Derived values are derived, not stored alongside their source.
- [ ] Global state holds only what genuinely needs to be global. Check `find_callers` on each store selector — a global read by one component is local state in the wrong place.

## Data fetching

- [ ] Requests are cancelled or ignored when the component unmounts. Otherwise a late response writes to a dead component.
- [ ] Nothing fetches in a render path.
- [ ] Refetch and invalidation rules are explicit. "It updates on reload" is a defect if the user expects it sooner.
- [ ] Waterfall requests — a fetch whose input comes from a previous fetch's output — are intentional, not accidental.

## Rendering correctness

- [ ] List keys are stable identities, not array indices.
- [ ] Effects declare every dependency they read, and none they do not.
- [ ] No layout shift from content that arrives late — reserved space or a skeleton.
- [ ] Forms are controlled consistently; a mix of controlled and uncontrolled inputs in one form is a bug waiting for a reset.

## Assets and bundle

- [ ] Images have dimensions and a modern format; nothing ships a 4 MB PNG as a thumbnail.
- [ ] Large dependencies are justified. Check the manifest against what is actually imported — cross-reference `Dependencies & Licensing`.
- [ ] Code splitting exists at route boundaries if the app has routes.
- [ ] Unused assets are reported under `Reachability`, not here.

## Severity guidance

| Situation | Severity |
|---|---|
| Late response writing to an unmounted component | Medium |
| Duplicated state that can diverge | Medium |
| Array index used as a list key over reorderable data | Medium |
| Fetch inside a render path | High |
| Effect with a missing dependency it reads | Medium |
| Copy-pasted shared UI | Low |
