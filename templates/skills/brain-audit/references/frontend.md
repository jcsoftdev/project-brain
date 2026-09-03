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
- [ ] No component is large enough that its responsibilities cannot be named in one sentence. `repo_map` ranks files by centrality; open the top-ranked component files and check their size and hook count — a component past roughly 200 lines or 5+ `use*` hooks — a local heuristic to trigger inspection, not a standard limit — is the trigger to inspect; `Read` the file to confirm the smell before reporting, since size alone is a signal, not proof (Hwang, Kweon, Rhee, Lee, Park, Jung, Jeon & Seo, arXiv preprint, 2026, https://arxiv.org/abs/2602.17891 — hook-dependency anti-patterns are specifically the class both unaided developers and an LLM coding assistant under-detect from source alone). A component where one custom hook's return value feeds directly into another hook's input — a chain of two or more `use*` calls threaded together, not independent sibling hooks — is read in full before judging it clean, even under this size/hook-count trigger; `Read` the chain end to end and confirm each link's dependency array matches what that link actually consumes. Rule out a standard composition (a `useQuery` result passed to a formatting hook with no internal state) with no reactive dependency mismatch.
- [ ] In a framework with Server Components, the client/server boundary is drawn at leaf interactivity, not at the top of a route. `search_code` for `"use client"` — a directive placed on a component that itself does no `useState`/`useEffect`/event handling but is an ancestor of components that do is dragging server-only work (and its dependencies) into the client bundle; `find_callees` on the flagged component shows what it pulls in. Rule out a directive placed there deliberately because the framework requires the boundary at a specific file (e.g. a layout that must export metadata) — confirm with `Read` before flagging (React core team, react.dev, "Server Components", 2025, https://react.dev/reference/rsc/server-components — the docs' own worked example quantifies an extra 75K gzipped of libraries shipped to the client from exactly this misplacement).
- [ ] Shared UI is shared, not copy-pasted. `search_code` a distinctive class string or markup shape from a button, card, or modal — duplicate hits are the finding. Rule out a repeated utility-class combination that Tailwind encourages; the finding is duplicated *structure*, not a repeated class string alone.
- [ ] Props are typed, and optional props default in one place. `find_symbol` the component to read its prop type, then `search_code` the prop name at its call sites — a default repeated at each call site instead of declared once in the component means every call site can drift from the others.

## State

- [ ] Each piece of state has one owner. `search_code` the state's field name across the codebase — the same data held in a local `useState` and in a global store at once will diverge the moment one updates without the other.
- [ ] Server data and UI state are distinguishable. `search_code` the data-fetching hook (`useQuery`, `useSWR`, or the project's own) and check whether its result is copied into the same store slice as ephemeral flags (`isOpen`, `activeTab`) — mixing them makes invalidation guesswork.
- [ ] Derived values are derived, not stored alongside their source. Read the store/reducer for a field whose value is always some function of another field in the same store (a count, a filtered list, a total) — if it is set explicitly rather than computed, it goes stale the moment one update path forgets it.
- [ ] Global state holds only what genuinely needs to be global. `find_callers` on each store selector — a selector read by exactly one component is local state living in the wrong place. Rule out a selector called from multiple sibling instances of the same component; that is legitimately shared.

## Data fetching

- [ ] Requests are cancelled or ignored on unmount. `search_code` for the fetching effect and check for an `AbortController`/cleanup return, or confirm the query library (React Query, SWR) handles this by default — a raw `fetch` inside `useEffect` with neither is a late response writing to a dead component (React core team, react.dev, "Synchronizing with Effects", current, https://react.dev/learn/synchronizing-with-effects — the cleanup function should either abort the fetch or ignore its result).
- [ ] Every subscription an Effect creates (`addEventListener`, `IntersectionObserver`/`ResizeObserver`/`MutationObserver`, a WebSocket, a third-party SDK's `.on(...)`) is torn down in that Effect's cleanup, not only fetch calls. `search_code` for the subscribing call inside a `useEffect` and check the returned function actually unsubscribes the same instance — a cleanup that unsubscribes a newly created instance instead of the one just created is not a fix. Rule out a subscription that is intentionally process-lifetime (a module-level singleton set up once outside any component's Effect) — not a per-mount subscription this check targets (React core team, react.dev, "Synchronizing with Effects", current, https://react.dev/learn/synchronizing-with-effects — the same effect-cleanup rule the fetch-cancellation check above narrows to fetches only; this restores the subscription half the source documents).
- [ ] Nothing fetches in a render path. `search_code` for the HTTP client call (`fetch(`, `axios.`) and read the call site — one sitting directly in a component body, outside any effect, handler, or loader, re-fires on every render.
- [ ] Refetch and invalidation rules are explicit. `search_code` the mutation hooks and check each one either calls the cache's invalidate/refetch or documents why it does not — a mutation with neither leaves stale data on screen until the next full reload (TanStack maintainers, tanstack.com, current, https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation — invalidating a query marks it stale and triggers an immediate background refetch when it is mounted; Vercel/SWR maintainers, swr.vercel.app, current, https://swr.vercel.app/docs/mutation — calling the global mutator with a key nobody is subscribed to is a silent no-op, not an invalidation).
- [ ] Waterfall requests — a fetch whose input comes from a previous fetch's output — are intentional, not accidental, in a component Effect and in server-executed data loading alike. `search_code` for nested `await` calls inside one async function or effect, and for consecutive `await` statements inside a Server Component (no `"use client"` directive) or loader-equivalent function; two independent fetches sequenced only by code order, with no real data dependency between them, is wasted latency (React core team, react.dev, "Server Components", 2025, https://react.dev/reference/rsc/server-components — without Server Components, nested client-side fetching creates "an expensive client-server waterfall"). Rule out a second call whose arguments genuinely reference the first call's result — a real dependency, not an accidental one.

## Rendering correctness

- [ ] List keys are stable identities, not array indices. `search_code` for `key={index}` or `.map((item, index)` feeding `index` into `key` — stable only if the list is never reordered, filtered, or spliced; confirm that before excusing it (React core team, react.dev, "Rendering Lists", current, https://react.dev/learn/rendering-lists — index-as-key "often leads to subtle and confusing bugs" because render order can change; a stable key must be a stable ID based on the data).
- [ ] Effects declare every dependency they read, and none they do not. `search_code` for `eslint-disable-next-line react-hooks/exhaustive-deps` — each suppression is a self-admitted gap; `Read` what the effect references against its dependency array. Rule out an effect with an empty dependency array whose comment or shape shows deliberate run-once-on-mount intent (a value read once at initialization, not meant to re-trigger the effect) (React core team, react.dev, "Removing Effect Dependencies", current, https://react.dev/learn/removing-effect-dependencies — suppressing the linter "lies" to React about what the Effect depends on; the official recommendation is to treat the dependency lint error as a compilation error).
- [ ] Interaction handlers (`onClick`, `onChange`, `onSubmit`) do not run unbounded synchronous work on the full dataset. `search_code` the handler body for a `.sort(`/`.filter(`/`.map(`/`JSON.parse(` over a list or payload with no visible size bound, called directly in the handler rather than memoized, debounced, or deferred (`useTransition`, `requestIdleCallback`). Rule out a handler that operates on an already-small, page-scoped list — the risk is proportional to the data size, not the presence of the pattern (web.dev/Google, current, https://web.dev/articles/inp — INP's poor threshold, >500ms, is explicitly attributed to long JavaScript tasks triggered by user interaction; this check targets the source-level shape of that defect class before any browser run exists to measure it directly).
- [ ] No layout shift from content that arrives late. Read the component's loading branch against its loaded branch — a loading branch that does not reserve the same space (a skeleton, a fixed `min-height`/`aspect-ratio`) as the loaded content is a confirmed CLS defect, not a guess (the width/height case of this is grounded by HTTP Archive, Web Almanac 2024, Media chapter, 2024, https://almanac.httparchive.org/en/2024/media — only 32% of `<img>` elements on mobile set both width and height, which the chapter states helps prevent CLS by reserving space before images load; the general skeleton/min-height case beyond images remains a practitioner heuristic, no source found).
- [ ] Forms are controlled consistently. `search_code` the form component for a mix of `value={}`/`onChange` on some fields and `defaultValue`/an uncontrolled ref on others in the same form — the mix is the defect, not either style alone.

## Assets and bundle

- [ ] Images declare dimensions and use a modern format. `search_code` for `<img`/`<Image` tags with neither `width`/`height` attributes nor a CSS aspect-ratio, and check the served file extensions against `.webp`/`.avif` availability (HTTP Archive, Web Almanac 2024, Media chapter, 2024, https://almanac.httparchive.org/en/2024/media — only 32% of `<img>` elements on mobile set both width and height; format mix on mobile still skews toward JPEG/PNG/GIF over AVIF/WebP, and 9.5% of LCP-responsible images are incorrectly marked lazy).
- [ ] Large dependencies are justified. Read the manifest from `get_architecture`, then `search_code` each heavy package's import sites — a dependency pulled in for one helper in one file is a candidate for inlining; cross-reference `Dependencies & Licensing` for the licensing angle (HTTP Archive, Web Almanac 2024, JavaScript chapter, 2024, https://almanac.httparchive.org/en/2024/javascript — median JS payload is 613 KB desktop / 558 KB mobile, with a median 206 KB (44%) of mobile bytes delivered but unused).
- [ ] Code splitting exists at route boundaries if the app has routes. `search_code` for `lazy(`, `dynamic(`, or the framework's route-level split convention — a route table importing every page eagerly ships the whole app on first load (HTTP Archive, Web Almanac 2024, JavaScript chapter, 2024, https://almanac.httparchive.org/en/2024/javascript — dynamic `import()` adoption on mobile rose from 0.34% in 2022 to 3.70% in 2024, still a small minority of pages code-split).
- [ ] Unused assets are reported under `Reachability` (`find_callers` on each asset import), not here.

## Out of static reach

- Actual re-render counts and effect firing order at runtime — a dependency array can look correct in source and still over-fire in practice.
- Real bundle size and per-chunk output — the manifest and import graph show what is *possible* to split, not what a bundler analysis would measure — closed by `runtime.md`'s declared `build` step when execution is enabled and the build tool reports chunk sizes, or by `browser.md`'s `resource-perf.md` when browser observation is enabled instead.
- Whether an unmounted-component write actually happens — the race depends on response timing, not just the presence or absence of cleanup.
- Actual network waterfall duration and perceived loading performance.
- Whether hydration delay is acceptable on the real device/network mix production traffic uses — a lab run is one preset, not the population.
- Whether a cleanup call actually removes the listener it was written to remove — this requires runtime argument identity, not text matching.
- The full reactive data-flow graph between a component's hooks — the structural call graph this audit reads is a different graph than the one that would need building.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `trace.json`/`insights.md` | Visible re-render storm: long tasks and render-blocking work during a walked flow that a correct-looking dependency array still produces in practice | Medium |
| `console.jsonl` | An unmounted-component write actually firing — React's own "Can't perform a React state update on an unmounted component" warning, tagged to the step that caused it | High |
| `network.jsonl` | Actual network waterfall duration and perceived loading performance on a walked flow | Low |
| `vitals.md`, corroborated by `screenshots/` before/after the loading→loaded transition | Real layout shift (CLS) against Google's threshold, on a walked flow — lab data, one machine; never a claim about real-user p75. Refuted when the CLS score is driven by an element unrelated to the loading branch under review (a late-loading ad slot elsewhere on the page) — attribute the shift to a specific element via `trace.json`/`insights.md` before tying it to this component | Medium |
| `network.jsonl` | Duplicated requests — the same call fired more than once for one user action, visible as repeated entries during a single step | Medium |
| `network.jsonl`, cross-referenced with `routes.md` | Code splitting at route boundaries actually effective at runtime — a route with `lazy(`/`dynamic(` in source but no new JS chunk request in `network.jsonl` at that navigation step means the split is not effective, whatever the source shape suggests. Refuted when the chunk was already loaded by an earlier prefetch (a router prefetch-on-hover visible earlier in `network.jsonl`) rather than bundled eagerly | Medium |
| `resource-perf.md` | Large dependencies' real cost on a walked page — the page's total JS weight against the HTTP Archive 2024 desktop median of 613 KB per page. Refuted when the heavy resource is confirmed non-render-blocking in `insights.md`/`trace.json` — a large but lazy, off-critical-path chunk is not the same defect as a large blocking one | Low |
| `resource-perf.md` and `network.jsonl` response headers/content-type | Images actually served on a walked page, against source `<img>`/`<Image>` markup found via `search_code`. Refuted when a legacy-format image is served only as a `<picture>` fallback whose modern-format `<source>` was the one actually requested — check which `Content-Type` the browser actually fetched | Low |
| `trace.json`/`insights.md` long-task entries and `vitals.md`'s INP figure | An interaction handler's expensive synchronous work confirmed or refuted at runtime, against Google's 200ms/500ms INP thresholds — lab data, one run, never a claim about real-user p75 INP. Refuted when the flagged handler's step shows no long task and INP stays under 200ms on this run — note it as unconfirmed-at-this-data-size, not false, since lab data is one dataset size | High |
| `console.jsonl`, `vitals.md`, `steps.md` timestamps | Hydration-related unresponsiveness on a walked flow — a React hydration-mismatch warning, elevated TBT/INP, and the gap between navigation and first successful interaction. Refuted when the delay is attributable to network/API latency visible in `network.jsonl` rather than client-side hydration cost | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Late response writing to an unmounted component | Medium |
| Duplicated state that can diverge | Medium |
| Array index used as a list key over reorderable data | Medium |
| Fetch inside a render path | High |
| Effect with a missing dependency it reads | Medium |
| Copy-pasted shared UI | Low |
| Client Component boundary drawn above leaf interactivity | Medium |
| Unbounded synchronous work in an interaction handler | Medium |
| Subscription not torn down in Effect cleanup | Medium |
| Hook-chain reactive mismatch missed by size heuristic alone | Medium |
| Waterfall requests in server-executed data loading | Medium |
