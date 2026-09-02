# Accessibility

Can everyone use it? Gate: a UI framework was detected. This module was documented in the original audit design but no gate ever enabled it — it could never run. It runs now.

Accessibility findings are unusually verifiable from source: most of them are the presence or absence of a specific attribute, and `search_code` finds them exactly.

This module owns the compliance line — the attribute, the ratio, the target size. `visual-design.md` owns the same territory as craft: emphasis, rhythm, state treatment. Where both would fire on one defect — colour as the sole carrier of meaning, missing reduced-motion handling — report it once, in whichever module is running, and cross-reference.

## Semantics

- [ ] Interactive things are interactive elements. `search_code` for `onClick` on `div` and `span` — each is a control keyboard and screen-reader users cannot reach. Rule out: a `div` that also carries `role="button"`, `tabIndex="0"`, and a keydown handler is compensating correctly; the finding is the ones missing all three.
- [ ] Headings form a real outline. `search_code` for `<h1` across page/route entry components — more than one per page, or a jump from `<h2` to `<h4` with no `<h3`, is the defect. Rule out a decorative element that is *styled* like a heading but uses no heading tag at all — that is a different, lesser issue than a skipped level.
- [ ] Landmarks exist. `search_code` for `<main`, `<nav`, `<header`, `<footer`, or `role="main"`/`role="navigation"` — a layout with none of these forces screen-reader users to tab through the entire page instead of jumping to content.
- [ ] Lists are lists, tables are tables with headers. `search_code` a `.map()` rendering repeated `<div>` siblings — if the surrounding markup has no `<ul>`/`<ol>`, that is a list read as an unstructured block by assistive tech. Run the same sweep for a grid-of-`<div>`s standing in for `<table>`. Rule out: a repeated block whose items are independent widgets, not a sequence of like items (a card grid, a dashboard of distinct panels), is not the finding — confirm the content is actually list-shaped before flagging.

## Keyboard

- [ ] Every action reachable by mouse has a keyboard path. `search_code` for `onClick` on `div`/`span` (the same sweep as Semantics above) with no accompanying keydown handler and no `tabIndex` — each match is a candidate action with no keyboard path. Confirming the walk end-to-end needs a running app; list the candidates here and put the actual walk under Out of static reach.
- [ ] Focus is visible. `search_code` for `outline: none` and `outline: 0` — each needs a replacement indicator. Rule out: check the same rule block for `box-shadow`, `outline-color`, or a `:focus-visible` override before reporting; a component that removes the default outline and defines its own ring is not a violation.
- [ ] Focus order follows visual order. `search_code` for `tabindex="1"` and above — positive values are a red flag. Rule out: if DOM order already matches visual order, a stray positive `tabindex` may be inert legacy code rather than an active reorder; read the surrounding markup before reporting it as live.
- [ ] Modals trap focus while open and restore it to the trigger on close. `find_symbol` the modal component and read its implementation — a focus-trap library import, or the native `<dialog>` element with `showModal()`, covers this; a hand-rolled modal with neither is a candidate. `search_code` for a `.focus()` call in its close handler to confirm restoration.
- [ ] Nothing is a keyboard trap. `find_symbol` the hand-rolled focus trap found above and `Read` its escape path: does Escape, or Tab past the last element, hand focus back out? Flag a trap with no exit path by inspection; confirming no trap exists anywhere still needs a keyboard pass, which belongs under Out of static reach.

## Pointer targets

- [ ] Interactive targets meet **24×24 CSS px** — WCAG 2.2 SC 2.5.8, Level AA. `search_code` icon-button and control components and read their declared `width`/`height`/`padding` to compute the effective box. Five exceptions exist and each must be argued, not assumed: sufficient spacing around a smaller target, an equivalent control elsewhere on the page, an inline target within a sentence, a size fixed by the user agent, or a presentation that is essential.
- [ ] Where the project claims AAA, or ships to touch as a primary input, the bar is **44×44 CSS px** — SC 2.5.5, which has no spacing escape hatch. Apple's guidance is 44×44pt and Material's is 48×48dp, both stricter than AA. `search_code` the same icon-button and control components as above and compute the same box against this bar.
- [ ] Icon-only buttons and close affordances are the usual failures. `search_code` for icon-button components and read their padding — a 16px icon in a box with no padding is a 16px target.
- [ ] The hit area is extended with padding rather than by enlarging the visual box. Read the icon-button CSS found above: padding around a small icon passes; a small box with the icon filling it edge-to-edge is the failure — and enlarging the box for compliance with no design pass is itself a regression worth calling out.
- [ ] Adjacent small targets have spacing between them. `search_code` for the toolbar/action-group markup housing multiple icon buttons and read the `gap`/margin between siblings — targets under 24px sharing an edge with no gap is the failure; two 44px targets a few px apart is not, even though neither hits the exact spacing formula.

## Names and roles

- [ ] Every image has `alt`, and decorative images have `alt=""` rather than a filename. `search_code` for `<img`/`<Image` tags missing an `alt` attribute entirely — that is the unambiguous defect. Where `alt` is present, read whether it is a filename (`alt="IMG_2043.png"`) or an auto-generated slug — both fail the check for a different reason.
- [ ] Icon-only buttons have an accessible name — these are the single most common miss. `search_code` the icon-button components found under Pointer targets for `aria-label`, `aria-labelledby`, or visually-hidden text — a button whose only content is an SVG or icon component, with none of the three, is unnamed to every screen reader.
- [ ] Form inputs have associated `label` elements, not just placeholders. `search_code` for `<input` and check each against a `<label htmlFor="...">` pointing at its `id`, or `aria-labelledby` — an input with only a `placeholder` and neither of those fails, because the placeholder disappears the moment the user types.
- [ ] Required, invalid, and error states are conveyed programmatically. `search_code` the form's error-display logic and check whether the invalid input also sets `aria-invalid="true"` and `aria-describedby` pointing at the message — a red border and a paragraph with neither attribute is invisible to a screen reader.
- [ ] `aria-*` attributes are valid for their element's role and are not contradicting native semantics. `search_code` for `aria-hidden="true"` and read what it wraps — a focusable element inside an `aria-hidden` subtree is reachable by keyboard but invisible to assistive tech, which is worse than not hiding it at all.

## Perception

- [ ] Colour is never the only carrier of meaning — error states, status badges, chart series. `search_code` the status-badge/error-text component and read whether an icon or text label ships alongside the colour class, or whether the colour class is the only differentiator between states.
- [ ] Text contrast meets 4.5:1 (3:1 for large text) **in every declared theme**, not only the default one. `Read` each theme's token file (found via `design-system.md`'s token source) to extract the foreground/background pairs and compute the ratio per pair; do not eyeball it. Where `design-system.md` found a partially covered theme, that gap is a contrast gap too.
- [ ] Content reflows at narrow widths. `search_code` the page-level container styles for a fixed `width`/`min-width` in px with no responsive override — a hard floor above ~320px is a static signal reflow will fail. Confirming actual reflow at 320px and 200% zoom needs a browser and belongs under Out of static reach.
- [ ] Motion respects `prefers-reduced-motion`. `search_code` for it — its absence alongside animation is a finding.

## Dynamic content

- [ ] Async status changes are announced. `search_code` for `aria-live` — if the loading/success/error states from `flow-integrity.md`'s triad render with no `aria-live` region anywhere in the tree, none of them are announced; they just silently change on screen.
- [ ] Client-side route changes move focus and update the document title. `search_code` the router's top-level layout or navigation listener for a `document.title =` assignment and a `.focus()` call triggered on route change — a single-page app with neither leaves a screen-reader user oriented on the previous page after every navigation.
- [ ] Auto-dismissing messages last long enough to be read, or are dismissible. `find_symbol` the toast/notification component and read its default duration and whether hover/focus pauses the timer — a fixed short timeout with no pause and no manual dismiss fails both ways.

## Out of static reach

- The keyboard walk itself, end to end, through a live app — source can only identify candidates for missing paths.
- Real screen-reader output — what NVDA, JAWS, or VoiceOver actually announces for a given markup pattern.
- Rendered contrast where colours composite — overlays, opacity, gradients (cross-reference `design-system.md`).
- Reflow behaviour at 320px and 200% zoom in an actual viewport.
- Whether an auto-dismiss duration feels sufficient to a real reader, as opposed to merely exceeding a numeric threshold.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | The keyboard walk end to end — whether every action candidate from the static sweep is actually reachable by keyboard, and whether tab order lands where the DOM/visual order implies | High |
| `a11y-snapshot.md` | An icon-only control's computed accessible name is empty (or wrong) as the browser's own accessibility tree resolves it, rather than inferred from source | High |
| computed styles via evaluate | Rendered contrast where colours composite — overlays, opacity, gradients — read from the applied colour, not a screenshot pixel | Medium |
| `steps.md` | Reflow behaviour at 320px and 200% zoom in an actual viewport | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Action reachable only by mouse | High |
| Interactive target below 24×24 CSS px with no exception applying | High |
| Adjacent small targets with no spacing between them | Medium |
| Icon-only control with no accessible name | High |
| Form input with no label | High |
| Focus outline removed with no replacement | Medium |
| Colour as the sole carrier of meaning | Medium |
| Contrast below 4.5:1 on body text | Medium |
| Missing `alt` on a meaningful image | Medium |
| Heading levels skipped | Low |
| No `prefers-reduced-motion` handling | Low |
