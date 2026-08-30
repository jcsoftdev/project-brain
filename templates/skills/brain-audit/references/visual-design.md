# Visual Design

Does the interface read correctly? Gate: a UI framework was detected.

`design-system.md` asks whether the values come from one vocabulary. This module asks whether the result communicates: what is important, what belongs together, what state the surface is in, and what it does on a small screen.

Two neighbouring modules own pieces of this on purpose — do not restate them. `flow-integrity.md` owns whether the loading/empty/error triad is **wired**; this module owns whether it is **designed**. `accessibility.md` owns contrast ratios, focus visibility and target size as compliance; this module owns emphasis, rhythm and density as craft. Cross-reference in both directions.

A caution before starting: much of visual quality is genuinely not decidable from source. Read the layout and the values, report what the code actually determines, and put the rest under coverage gaps. **A confident aesthetic verdict with no evidence is worse than an honest gap.** Every check below is anchored to a declaration, a value, or a class that can be read directly — not to an impression of how it looks rendered.

## Hierarchy

- [ ] Emphasis comes from size, weight, contrast and spacing — not from position alone. `search_code` the heading component/classes used across views and diff their `font-size`/`font-weight` values — if every heading level resolves to the same computed size, order is the only signal of importance, which is not hierarchy.
- [ ] Hierarchy survives without colour. Read the primary and secondary action components side by side: if the only declared difference between them is a colour token (`bg-primary` vs `bg-secondary`) with identical size, weight, and border, colour is carrying the whole distinction — readable directly from the class list, no rendering needed. Cross-reference the colour-only check in `accessibility.md`.
- [ ] One primary action per view. `search_code` the primary-button variant/class and count occurrences within a single page or view component's render tree — two hits in one view is two competing primaries; read the surrounding markup to confirm both are visible at once rather than in alternate states.
- [ ] Secondary and destructive actions are visually subordinate to the primary one, and destructive actions are distinguishable from merely secondary ones by more than colour. `search_code` the destructive-variant class/component and read whether it also differs in icon, copy, or a confirmation step — a destructive button that is only a red version of the secondary button fails the moment the token gets swapped in a redesign.
- [ ] Supporting text is de-emphasised by weight or colour role, not by shrinking below the readable floor. `search_code` the muted/secondary text token or class for its resolved `font-size` — below ~12–14px in a content role it has traded legibility for hierarchy instead of using weight or colour role.

## Rhythm and grouping

- [ ] Related elements are closer to each other than to unrelated ones. Read a representative group component's spacing declarations and compare the gap between its own children to the margin separating it from the next group — equal values (`gap-4` inner, `mb-4` outer) means proximity carries no signal; this is a literal comparison, not a judgment call.
- [ ] Spacing between sections is consistent for the same level of nesting. `search_code` the section/wrapper component's spacing prop or class across the pages that use it — distinct values at the same nesting depth for the same role is drift, listable straight from the class strings.
- [ ] Alignment is deliberate: elements share edges. `search_code` sibling components inside the same container and compare their declared horizontal padding/margin — a one-off asymmetric value on a single sibling among otherwise-matching siblings is the static signature of a near-alignment bug. True pixel-level misalignment arising from box-model interactions still needs a rendered check — note it under Out of static reach.
- [ ] Density is consistent within a surface. `search_code` the padding/gap values used by components rendered together on one route (a table and a card on the same dashboard, say) — a dense table (`p-1`, `gap-1`) beside an airy card (`p-6`, `gap-6`) on one screen is readable directly from the two class lists.
- [ ] Vertical rhythm holds — spacing derives from the type scale rather than being chosen per block. Cross-reference the scale established in `design-system.md`; `search_code` for `margin-bottom`/`margin-top` on text elements and check each value is a step on that scale rather than a one-off number.

## Typography in use

`design-system.md` checks the scale exists. This checks it is used well.

- [ ] Line length lands in 45–90 characters, ideally near 66 for body copy. `search_code` for the prose/body-copy container and check for a `max-width` in `ch` units or an equivalent px value (~600–700px at typical body size) — its absence in a fluid-width layout is a readability defect visible in the container's own declaration.
- [ ] Line height is around 1.5 for body text (1.4–1.6), rising to 1.6–1.7 where the measure runs long, and 1.1–1.25 for headings. `search_code` for `line-height` on the body-text and heading tokens/classes — a single shared value applied to both (common when only one `line-height` token exists) is wrong for one of them by construction.
- [ ] Body text does not go below the project's readable floor. `search_code` the body-text token/class for its resolved `font-size` — anything under ~14px in a content role (not a caption or label role) needs a stated reason, found in the same declaration or flagged by its absence.
- [ ] Numeric and tabular data uses tabular figures or a monospaced face where columns must align. `search_code` the table/numeric-cell component for `font-variant-numeric` or a monospace font stack — a table rendering right-aligned numeric columns with neither will visibly misalign digit widths.
- [ ] Fluid type via `clamp()` or container queries where the layout spans phone to desktop. `search_code` the type-scale source for `clamp(` — its absence alongside a large declared breakpoint set (four or more, per `design-system.md`) means every size is fixed per breakpoint; worth flagging only at that scale.

## State coverage

The states a browser gives you free are the ones most often left unstyled:

- [ ] `:hover`, `:focus-visible`, `:active` and `:disabled` are all styled for every interactive element. `search_code` the button/input component's style definitions for each of the four selectors (or their `hover:`/`focus-visible:`/`active:`/`disabled:` utility variants) and list which are absent per component — `:disabled` is the one most often skipped, and the one that most confuses a user.
- [ ] No affordance exists only on hover. `search_code` for `hover:opacity`/`hover:visible`/`:hover { display` patterns that reveal an action, then check the same rule block for a `:focus-within` or `group-focus` counterpart — a reveal driven only by `:hover` has no touch or keyboard path.
- [ ] Disabled controls communicate *why*, or the control is not disabled in the first place. `search_code` where the disabled condition is set (`disabled={`) and read the surrounding markup for a tooltip, helper text, or `aria-describedby` explaining it — a bare `disabled` prop with nothing else nearby is a dead end with no stated cause.
- [ ] The application states — loading, empty, no-results, error, success, offline — each have a designed treatment, not just a wired one. For each state component `flow-integrity.md` confirms is wired, `find_symbol` it and read what it renders: a bare string (`<p>Loading...</p>`) is wired but undesigned; a skeleton, icon, or illustration matching the content shape is designed.
- [ ] A skeleton that does not match the shape of the content it replaces causes the layout shift it was meant to prevent. Read the skeleton component's markup against the loaded-state component it stands in for — a fixed count of placeholder lines against a variable-length list, or a skeleton height differing from the real content's, is a static mismatch.
- [ ] Empty states say what to do next, not only that there is nothing. `find_symbol` the empty-state component and read whether it renders a call-to-action element alongside the message — text with no button or link is a dead end for a first-time user.
- [ ] Error states name the problem and the recovery. `search_code` for the literal error copy ("Something went wrong", "An error occurred") and read whether a retry button or next step renders alongside it — generic copy with no action is a wired triad, not a designed one.

## Responsive behaviour

- [ ] Breakpoints sit where the layout actually breaks, not at device names. `design-system.md` already checks the declared breakpoint scale itself; this module's angle is whether one specific layout's column-count change lines up with it — `search_code` the layout component for an inline `@media` query with a value that does not match the declared scale.
- [ ] Every layout that is multi-column at desktop has a defined single-column behaviour. `search_code` the grid/flex container's declarations across its breakpoint variants — a `grid-template-columns` set with three or more columns and no narrower override (no `sm:`/`md:` variant, no matching `@media` rule) will not collapse; confirm from the declarations, not from the assumption that flexbox always wraps.
- [ ] Tables, charts and wide fixed-width content have an explicit small-screen strategy (scroll container, card fallback, column priority). `search_code` the table/chart wrapper for `overflow-x: auto`/`scroll`, a conditional card-fallback render, or a column-priority prop — absent all three, the wrapper overflows on narrow screens, provable straight from its own declarations.
- [ ] Nothing depends on hover or on precise pointer targeting for a core action. Cross-reference the hover-only affordance check above and the target-size check in `accessibility.md` — a core action gated behind either is unreachable to a touch user; report it once, in whichever module surfaced it first.
- [ ] Content order in the DOM matches the intended reading order at every breakpoint. `search_code` for the CSS `order` property, `grid-area` placement, or `position: absolute` in layout components, and compare against the JSX/template source order — a CSS-driven reorder that diverges from source order is both a visual and a keyboard-order defect, provable by comparing the two orderings directly.

## Motion

- [ ] Animation has a purpose — continuity, feedback, or direction of attention. `search_code` for `animate-`/`transition-`/`@keyframes` usage and read what triggers each — an animation with no state change, user action, or data arrival driving it (a looping decorative animation on a primary flow) is decorative motion, provable from its trigger, not from taste.
- [ ] Durations come from a bounded set, and are short for feedback (roughly 100–200ms) and longer only for transitions that move something across the screen. `search_code` for `duration-`/`transition-duration:` values and list the distinct numbers found — feedback interactions (hover, click, toggle) resolving above ~200ms, or an unbounded spread of one-off durations, is the static signature.
- [ ] `prefers-reduced-motion` is honoured wherever motion exists. `search_code` for it — its absence alongside animation is a finding here as well as in `accessibility.md`; flag it once, in whichever module is running.
- [ ] Nothing animates layout properties on a hot path where a transform would do. `search_code` for `transition:`/`animate-` rules whose property list includes `top`, `left`, `width`, `height`, or `margin` instead of `transform`/`opacity` — each is a forced-layout animation, verifiable from the property name alone; cross-reference `performance.md` for the runtime cost.

## Out of static reach

- Whether the composition is balanced, and whether the visual weight lands where the product wants attention.
- Pixel-level alignment and spacing as actually rendered, beyond what the declared values predict — box-model interactions (collapsed margins, sub-pixel rounding) can still shift things.
- How the surface degrades at 200% zoom and at 320px, beyond what the declarations promise.
- Whether motion feels smooth at runtime, and on a mid-range device — a bounded duration set says nothing about actual frame rate.
- Brand fit and tone.

Recommend a browser pass or a visual-regression suite for these rather than asserting them.

## Severity guidance

| Situation | Severity |
|---|---|
| Core action available only on hover | High |
| Hierarchy carried by colour alone | High |
| No small-screen strategy for content that overflows | High |
| Interactive element with no styled focus or disabled state | High |
| Empty or error state that offers no way forward | Medium |
| Two competing primary actions in one view | Medium |
| Skeleton whose shape does not match its content | Medium |
| Unbounded line length on body copy | Medium |
| Grouping not expressed by proximity | Medium |
| One global line height across body and display type | Low |
| Near-alignment — edges off by a few pixels | Low |
| Decorative motion with no reduced-motion fallback | Low |
