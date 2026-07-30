# Accessibility

Can everyone use it? Gate: a UI framework was detected. This module was documented in the original audit design but no gate ever enabled it — it could never run. It runs now.

Accessibility findings are unusually verifiable from source: most of them are the presence or absence of a specific attribute, and `search_code` finds them exactly.

## Semantics

- [ ] Interactive things are interactive elements. `search_code` for `onClick` on `div` and `span` — each is a control keyboard and screen-reader users cannot reach.
- [ ] Headings form a real outline: one `h1`, no skipped levels, order reflects structure rather than font size.
- [ ] Landmarks exist — `main`, `nav`, `header`, `footer` — so a screen-reader user can skip to content.
- [ ] Lists are lists, tables are tables with headers, and neither is a stack of divs.

## Keyboard

- [ ] Every action reachable by mouse is reachable by keyboard. Walk the flows from `flow-integrity.md` using Tab and Enter only.
- [ ] Focus is visible. `search_code` for `outline: none` and `outline: 0` — each needs a replacement indicator.
- [ ] Focus order follows visual order. Positive `tabindex` values are a red flag; `search_code` for `tabindex="1"` and above.
- [ ] Modals trap focus while open and restore it to the trigger on close.
- [ ] Nothing is a keyboard trap — every focusable region can be left with the keyboard.

## Names and roles

- [ ] Every image has `alt`, and decorative images have `alt=""` rather than a filename.
- [ ] Icon-only buttons have an accessible name — `aria-label` or visually-hidden text. These are the single most common miss.
- [ ] Form inputs have associated `label` elements, not just placeholders. A placeholder disappears on input and is not a label.
- [ ] Required, invalid, and error states are conveyed programmatically (`aria-required`, `aria-invalid`, `aria-describedby`), not only by colour or position.
- [ ] `aria-*` attributes are valid for their element's role and are not contradicting native semantics.

## Perception

- [ ] Colour is never the only carrier of meaning — error states, status badges, chart series.
- [ ] Text contrast meets 4.5:1 (3:1 for large text). Extract the colour pairs from the theme and compute; do not eyeball it.
- [ ] Content reflows at 320px width and at 200% zoom without loss.
- [ ] Motion respects `prefers-reduced-motion`. `search_code` for it — absence alongside animation is a finding.

## Dynamic content

- [ ] Async status changes are announced — live regions for loading, success, and error, matching the triad in `flow-integrity.md`.
- [ ] Client-side route changes move focus and update the document title.
- [ ] Auto-dismissing messages last long enough to be read, or are dismissible.

## Severity guidance

| Situation | Severity |
|---|---|
| Action reachable only by mouse | High |
| Icon-only control with no accessible name | High |
| Form input with no label | High |
| Focus outline removed with no replacement | Medium |
| Colour as the sole carrier of meaning | Medium |
| Contrast below 4.5:1 on body text | Medium |
| Missing `alt` on a meaningful image | Medium |
| Heading levels skipped | Low |
| No `prefers-reduced-motion` handling | Low |
