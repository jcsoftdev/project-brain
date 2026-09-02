# Frontend

Client-side structure and correctness. Gate: a UI framework was detected.

Family B does the wiring work — orphan handlers and the loading/empty/error triad live in `flow-integrity.md`. Do not duplicate them here; cross-reference.

Three modules split the UI between them, and the boundary is what each one is asking about a component:

| Question | Module |
|---|---|
| Is it built correctly? — state ownership, effects, fetching, keys, bundle | `frontend.md` (here) |
| Do its values come from one vocabulary? — tokens, scales, variants, theming | `design-system.md` |
| Does it read correctly? — hierarchy, rhythm, state treatment, responsive behaviour | `visual-design.md` |

Duplicated component *structure* is a finding here. The *values that have diverged* between those duplicates belong to `design-system.md`. Report each once, in its own module, and cross-reference.

## Component structure

- [ ] Components separate what they show from where the data comes from. Read the component: does it call `fetch`/a query hook, transform the result, *and* render markup, all in one file? That is three reasons to change. Rule out: a container component whose only job is composing children is not a violation — the smell is business logic mixed with render, not composition itself.
- [ ] No component is large enough that its responsibilities cannot be named in one sentence. `repo_map` ranks files by centrality; open the top-ranked component files and check their size and hook count — a component past roughly 200 lines or 5+ `use*` hooks — a local heuristic to trigger inspection, not a standard limit — is the trigger to inspect; `Read` the file to confirm the smell before reporting, since size alone is a signal, not proof.
- [ ] Shared UI is shared, not copy-pasted. `search_code` a distinctive class string or markup shape from a button, card, or modal — duplicate hits are the finding. Rule out a repeated utility-class combination that Tailwind encourages; the finding is duplicated *structure*, not a repeated class string alone.
- [ ] Props are typed, and optional props default in one place. `find_symbol` the component to read its prop type, then `search_code` the prop name at its call sites — a default repeated at each call site instead of declared once in the component means every call site can drift from the others.

## State

- [ ] Each piece of state has one owner. `search_code` the state's field name across the codebase — the same data held in a local `useState` and in a global store at once will diverge the moment one updates without the other.
- [ ] Server data and UI state are distinguishable. `search_code` the data-fetching hook (`useQuery`, `useSWR`, or the project's own) and check whether its result is copied into the same store slice as ephemeral flags (`isOpen`, `activeTab`) — mixing them makes invalidation guesswork.
- [ ] Derived values are derived, not stored alongside their source. Read the store/reducer for a field whose value is always some function of another field in the same store (a count, a filtered list, a total) — if it is set explicitly rather than computed, it goes stale the moment one update path forgets it.
- [ ] Global state holds only what genuinely needs to be global. `find_callers` on each store selector — a selector read by exactly one component is local state living in the wrong place. Rule out a selector called from multiple sibling instances of the same component; that is legitimately shared.

## Data fetching

- [ ] Requests are cancelled or ignored on unmount. `search_code` for the fetching effect and check for an `AbortController`/cleanup return, or confirm the query library (React Query, SWR) handles this by default — a raw `fetch` inside `useEffect` with neither is a late response writing to a dead component.
- [ ] Nothing fetches in a render path. `search_code` for the HTTP client call (`fetch(`, `axios.`) and read the call site — one sitting directly in a component body, outside any effect, handler, or loader, re-fires on every render.
- [ ] Refetch and invalidation rules are explicit. `search_code` the mutation hooks and check each one either calls the cache's invalidate/refetch or documents why it does not — a mutation with neither leaves stale data on screen until the next full reload.
- [ ] Waterfall requests — a fetch whose input comes from a previous fetch's output — are intentional, not accidental. `search_code` for nested `await` calls inside one async function or effect; two independent fetches sequenced only by code order, with no real data dependency between them, is wasted latency.

## Rendering correctness

- [ ] List keys are stable identities, not array indices. `search_code` for `key={index}` or `.map((item, index)` feeding `index` into `key` — stable only if the list is never reordered, filtered, or spliced; confirm that before excusing it.
- [ ] Effects declare every dependency they read, and none they do not. `search_code` for `eslint-disable-next-line react-hooks/exhaustive-deps` — each suppression is a self-admitted gap; `Read` what the effect references against its dependency array. Rule out an effect with an empty dependency array whose comment or shape shows deliberate run-once-on-mount intent (a value read once at initialization, not meant to re-trigger the effect).
- [ ] No layout shift from content that arrives late. Read the component's loading branch against its loaded branch — a loading branch that does not reserve the same space (a skeleton, a fixed `min-height`/`aspect-ratio`) as the loaded content is a confirmed CLS defect, not a guess.
- [ ] Forms are controlled consistently. `search_code` the form component for a mix of `value={}`/`onChange` on some fields and `defaultValue`/an uncontrolled ref on others in the same form — the mix is the defect, not either style alone.

## Assets and bundle

- [ ] Images declare dimensions and use a modern format. `search_code` for `<img`/`<Image` tags with neither `width`/`height` attributes nor a CSS aspect-ratio, and check the served file extensions against `.webp`/`.avif` availability.
- [ ] Large dependencies are justified. Read the manifest from `get_architecture`, then `search_code` each heavy package's import sites — a dependency pulled in for one helper in one file is a candidate for inlining; cross-reference `Dependencies & Licensing` for the licensing angle.
- [ ] Code splitting exists at route boundaries if the app has routes. `search_code` for `lazy(`, `dynamic(`, or the framework's route-level split convention — a route table importing every page eagerly ships the whole app on first load.
- [ ] Unused assets are reported under `Reachability` (`find_callers` on each asset import), not here.

## Out of static reach

- Actual re-render counts and effect firing order at runtime — a dependency array can look correct in source and still over-fire in practice.
- Real bundle size and per-chunk output — the manifest and import graph show what is *possible* to split, not what a bundler analysis would measure — closed by `runtime.md`'s declared `build` step when execution is enabled and the build tool reports chunk sizes.
- Whether an unmounted-component write actually happens — the race depends on response timing, not just the presence or absence of cleanup.
- Actual network waterfall duration and perceived loading performance.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `trace.json`/`insights.md` | Visible re-render storm: long tasks and render-blocking work during a walked flow that a correct-looking dependency array still produces in practice | Medium |
| `console.jsonl` | An unmounted-component write actually firing — React's own "Can't perform a React state update on an unmounted component" warning, tagged to the step that caused it | High |
| `network.jsonl` | Actual network waterfall duration and perceived loading performance on a walked flow | Low |
| `vitals.md` | Real layout shift (CLS) against Google's threshold, on a walked flow — lab data, one machine; never a claim about real-user p75 | Medium |
| `network.jsonl` | Duplicated requests — the same call fired more than once for one user action, visible as repeated entries during a single step | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Late response writing to an unmounted component | Medium |
| Duplicated state that can diverge | Medium |
| Array index used as a list key over reorderable data | Medium |
| Fetch inside a render path | High |
| Effect with a missing dependency it reads | Medium |
| Copy-pasted shared UI | Low |
