# Design audit reference

Each finding: category, impact (high, medium, polish), screenshot, measured value.

## Surface mode

| Mode | Visitor's win | Rules |
|---|---|---|
| Persuade (landing, pricing) | decides and acts | brand > headline > body > CTA; one composition in the first viewport; one job per section; cards only when the card is the interaction; one authored motion moment |
| Operate (app, dashboard, settings) | finishes a task | scanability and native expectations; calm surfaces, few colors; utility copy; headings say what the area is |
| Read (docs, articles) | understands | 65-75ch measure, one column, wayfinding; no hero or CTA theater |
| Experience (portfolio) | is inside the work | artifact owns the first viewport; one transition, no scroll-jacking |
| Hybrid | per section | classify each section |

Instant-fail patterns: generic SaaS card grid as first impression; strong headline with no clear action; busy imagery behind text; carousel with no narrative; app UI made of stacked cards.

## Trunk test (per page)

Answer at once: what site, what page, major sections, my options, where am I, how do I search. All six pass; four or five partial; three or fewer is a high finding.

## Ten categories

1. **Hierarchy**: one focal point, one primary CTA per view, squint test, intentional white space, purpose clear in 3 seconds.
2. **Typography**: at most 3 families; scale ratio 1.25-1.333; line-height 1.5 body and 1.15-1.25 headings; 45-75 chars per line; no skipped heading levels; at least 2 weights; body at least 16px, labels at least 12px; `text-wrap: balance` on headings; `tabular-nums` on number columns; curly quotes and `…`.
3. **Color and contrast**: at most 12 non-gray colors; AA 4.5:1 body, 3:1 large text and UI; no color-only encoding; semantic colors consistent; dark mode uses elevation, off-white text and `color-scheme`.
4. **Spacing and layout**: 4 or 8 base scale; consistent grid and alignment; related items closer than sections; radius hierarchy, inner radius = outer minus gap; max content width; URL reflects state.
5. **Interaction states**: hover, `focus-visible` ring, active, disabled; skeletons match content; empty states with an action; specific errors with the next step; targets at least 44px; every decision a mindless click.
6. **Responsive**: 375, 768, 1024, 1440; mobile is designed, not stacked; no horizontal scroll; no `user-scalable=no`.
7. **Motion**: ease-out enter, 50-700ms, purposeful, `prefers-reduced-motion` honored, no `transition: all`, animate transform and opacity only.
8. **Content**: specific button labels, no lorem, truncation handled, active voice, destructive actions confirmed or undoable, happy-talk word count reported, instructions longer than a sentence mean the design failed.
9. **AI slop**: purple or blue-to-purple gradients; the 3-column icon-circle feature grid; icons in colored circles; everything centered; uniform bubbly radius; blobs and wavy dividers; emoji as design; colored left-border cards; generic hero copy; cookie-cutter section rhythm; system-ui as the display face; gradient buttons; stock hero; testimonial rows with invented quotes; three big vanity numbers; same-shape card grids; frosted glass everywhere; generated SVG mascots; sparklines or avatars as filler; only the happy path designed. Polish-only: bounce easing, pulsing dots, thin border plus wide shadow, numbered section labels, em-dash overuse.
10. **Performance as design**: LCP under 2.0s (1.5s informational), CLS under 0.1, image dimensions and lazy loading, `font-display: swap`. Use `lighthouse_audit` and a performance trace for the numbers.

## Reflexes no detector catches

Shadows have an offset; a zero-offset colored halo is decoration. Secondary text on a colored surface is tinted, not gray. More space above a heading than below. Light or dark follows the use scene (who, where, under what light), not the category. Labels never live only as placeholders. Visited links differ.

## Scoring

Each category starts at A. High impact: minus one letter. Medium: minus half. Polish: no change. Floor F.

| Category | Weight |
|---|---|
| Hierarchy, Typography, Spacing | 15% each |
| Color, Interaction, Responsive, Content | 10% each |
| AI slop, Motion, Performance | 5% each |

Report Design Score (weighted) and AI Slop Score (standalone, with a one-line verdict). Regression: load the prior baseline, print per-category deltas, new and resolved findings.

## Goodwill meter

Start 70. Drains: hidden info the user wants -15; interstitial or forced tour -15; format punishment -10; unnecessary data request -10; sloppy look -10; ambiguous choice -5. Fills: obvious top task +10. Print one line per step and a final value. Under 30 critical, 30-60 needs work, over 60 healthy.

## Rules

Specific and actionable, "change X to Y because Z". Depth over breadth: 5-10 documented findings beat 20 vague ones. Name AI slop directly. Document each finding as found.
