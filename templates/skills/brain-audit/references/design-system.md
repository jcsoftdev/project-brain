# Design System

Does the UI agree with itself? Gate: a UI framework was detected.

`consistency.md` asks whether the *code* agrees with itself. This module asks the same question of the *rendered surface*: are colours, spacing, type, radii, shadows and component variants drawn from one declared vocabulary, or reinvented per file?

The method is the same as `consistency.md` — comparison, not taste. Find the declared vocabulary, then find what ignores it. **A value that deviates from the dominant pattern is the finding; the dominant pattern is the standard even if you would have chosen differently.**

Everything here is verifiable from source. Design-system audits are usually described as a visual exercise — screenshot every component across breakpoints and record mismatches. That needs a running app. It is not needed: the defects have textual signatures, because the values are literals in the code. What genuinely cannot be checked statically is listed at the end, and naming it is a coverage-gap finding, not a silent omission.

## Establish the vocabulary first

Nothing below means anything until you know what the project declared. Find it before you judge anything.

- [ ] Locate the token source. `search_code` for `tailwind.config`, `@theme`, `:root {`, `--color-`, `theme.ts`, `tokens.json`, `styled-components` theme, `ThemeData`, `MaterialTheme`, or the platform equivalent.
- [ ] `Read` the token source located above and record the declared scales — spacing steps, type sizes, radii, shadow levels, breakpoints, colour roles — enumerating its declared values verbatim. This list is the yardstick for every later check.
- [ ] **If no token source exists at all, that is the finding — `High` — and the rest of the module becomes "every value is ad hoc", not thirty separate deviations.** Report it once, with the count of distinct raw values `search_code` turns up for a single representative category (colour is usually the fastest to count) as evidence of the scale that never existed.

## Token adoption

Score it; do not eyeball it. Per category — colour, spacing, radius, typography, shadow, z-index:

```
adoption = token_references / (token_references + hardcoded_literals)
```

- [ ] Report the number **per category with raw counts**, tallying the `search_code` hits from each category probe below against the token count recorded above. A project can sit at 95% on colour and 20% on spacing, and a single average hides exactly the category that needs work.
- [ ] Hardcoded colour outside the token file: `search_code` for `#[0-9a-fA-F]{3,8}`, `rgba?(`, `hsla?(`. Each hit outside the declared source is a missing token.
- [ ] Hardcoded dimension: `search_code` for a raw `[0-9]+px` inside `margin`, `padding`, `gap`, `width`, `height`, or `font-size` declarations. Each hit outside the token scale is a missing token.
- [ ] Escape-hatch syntax in utility-class stacks: `search_code` for the pattern `-[` inside class strings (`w-[137px]`, `text-[#3b82f6]`, `mt-[13px]`) and count hits against total class-string occurrences project-wide. A handful is pragmatism. A third of the class strings means there is no system left, only a colour-coordinated accident.
- [ ] A literal repeated in more than one file is a token that was never created. `search_code` a suspect hex or pixel value found above across the repo — two or more files sharing the exact same raw value is the finding; report it once with every site, not once per site.

## Scale discipline

- [ ] Spacing values come from a constrained scale (4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 …). `search_code` for the raw `px` hits already found under Token adoption above and list every value that is not on the declared scale, or — absent a declared scale — not a multiple of a consistent base unit, and where each occurs.
- [ ] Type sizes come from one scale — a modular ratio or an explicit named ramp. `search_code` for `font-size` declarations outside the token file and list each resolved value; a size that appears exactly once across the codebase is drift, not a considered addition.
- [ ] Radii, border widths, shadow levels and z-index each have a bounded set. `search_code` for `z-index:`/`z-` utility classes and list every distinct raw value found outside the token file — more than a handful means there is no stacking policy and overlays will fight. Repeat the sweep for `border-radius` and `box-shadow`.
- [ ] Breakpoints are declared once and referenced, not retyped per component. `search_code` for `@media` queries or breakpoint utility prefixes (`sm:`, `md:`, `lg:`) carrying a raw pixel value instead of the declared token — each is a breakpoint retyped locally. Device-named breakpoints (iPhone, iPad widths) are a further smell — breakpoints belong where the layout breaks.

## Token architecture

Where a three-tier structure exists — primitive → semantic → component — the tiering is only real if it is respected:

- [ ] A token references **exactly one tier below**. `find_symbol` each component-tier token and read what it resolves to — a value pointing straight at a hex or raw px (skipping the semantic tier), or reaching sideways into an unrelated branch, defeats the indirection the tiers exist to provide.
- [ ] Semantic and component tokens are named for their **role**, never their value. `search_code` semantic/component token names for a colour or size word baked in (`red`, `blue`, `large`) — `color.brand.red` is a primitive name wearing semantic clothes: harmless at tier 1, a trap at tier 2, where the whole point of the name is that the value can change.
- [ ] No two tokens hold near-identical values. Read the token file's colour values sorted — `#3b82f6` and `#3b82f7` sitting as separate named entries is drift, not intent.
- [ ] Deprecated tokens are marked and have a stated replacement, not silently kept alive by their remaining call sites. `search_code` for a `deprecated`/`@deprecated` marker in the token file, then `find_callers` each marked token — live call sites with no stated replacement is a trap for the next person who reaches for it.

## Two sources of truth

The most expensive defect in this module, and the easiest to miss by reading one file:

- [ ] Only one place defines each foundation. `search_code` for a second file matching the same token-source patterns as the one located earlier — a `variables.scss` **and** a `tailwind.config`/`@theme` block both declaring brand colours will drift, and by the time anyone notices, both are load-bearing. Diff them literally, value by value.
- [ ] Design-tool exports (Figma tokens, Style Dictionary output) are generated into the codebase, not hand-maintained alongside it. `search_code` for a Style Dictionary config or a generated-file header comment in the token file — its absence alongside evidence of a Figma-variables integration means the file is hand-edited and will drift from the design tool silently.
- [ ] Theme values are not duplicated between web and native targets in a shared-code project. `search_code` the same colour-role name across the web token file and the native theme file (`Colors.ts`, platform theme) — a role holding different values on each platform is cross-surface drift; cross-reference `contract-drift.md`.

## Component vocabulary

- [ ] One implementation per concept. `search_code` a distinctive class string or markup shape from a button, card, input, modal — duplicates are the finding. Cross-reference the copy-paste check in `frontend.md`; report the *divergence in values* here and the *structural duplication* there.
- [ ] Variants live in one place — a variant helper (`cva`, `tv`, or the project's own), not inline ternaries on `className`. `search_code` for a variant-helper import versus a ternary chain building `className` inside a component — inline variant logic means the variant set is defined N times and will diverge.
- [ ] Conditional classes go through a merge helper (`cn()` / `clsx` + `twMerge` or equivalent). `search_code` for `cn(`, `clsx(`, `twMerge(` versus a template-literal or `+` concatenation building a class string — without a merge helper, a conditional class silently loses to source order and the bug looks like "sometimes the style does not apply".
- [ ] Component APIs for the same role have the same shape. `find_symbol` each component sharing a role (button, input, badge) and diff their prop names for the same concept — a `size` prop that takes `sm|md|lg` in one component and `small|medium|large` in another is two vocabularies for one idea.

## Theming

- [ ] Every colour role has a counterpart in every declared theme. `search_code` for `dark:` / `[data-theme]` / `prefers-color-scheme` and check the coverage is total, not partial — a half-themed surface is worse than an unthemed one, because it only breaks on some screens.
- [ ] Theme switching goes through tokens, not through per-component conditionals. `search_code` for `theme ===`/`isDarkMode ?` branching inline in component style logic, as opposed to a CSS variable or token swap driven by a theme class/attribute — a per-component conditional is a theme implemented N times instead of once.
- [ ] Contrast is reported under `accessibility.md` (`Read` each theme's token file and compute the ratio per pair); this module's job is only to supply the colour pairs it needs — `search_code` the token source located above for each theme's foreground/background role pairs and hand the list to that check, rather than computing and reporting the ratio here too.

## Enforcement

- [ ] A lint rule enforces what the token system declares. `search_code` for a stylelint rule (a `declaration-property-value-disallowed-list` on hex/`color`) or an eslint rule on Tailwind arbitrary values (`eslint-plugin-tailwindcss`) — its absence means the discipline above is a convention nobody enforces at commit time.
- [ ] CI actually runs that rule. `search_code` the CI workflow files for the lint command found above — a rule declared in config but absent from the CI script list runs only on a developer's machine, if at all. A declared standard nothing enforces is optional, and optional standards decay. Cross-reference the tooling check in `consistency.md`.
- [ ] Visual-regression or theme coverage exists in the test suite. `search_code` for a visual-regression tool import (Chromatic, Percy, Playwright's `toHaveScreenshot`) or a theme-toggle test — its absence is reported under `testing.md`, not silently skipped here.

## Out of static reach

- Rendered contrast where colours composite — overlays, opacity, gradients.
- Reflow at 320px and at 200% zoom.
- Perceived hierarchy and visual balance.
- Whether the dominant pattern is the *intended* one, when no token source exists to declare it.
- Whether a value flagged as off-scale is a deliberate, argued exception or an unnoticed accident — source shows the deviation, not the intent behind it.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Contrast findings are reported under `accessibility.md`, at that module's severity, per the ownership split above.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| computed styles via evaluate | Rendered contrast where colours composite — overlays, opacity, gradients — read from the applied colour, not a screenshot pixel | Medium |
| `steps.md` | Reflow at 320px and at 200% zoom, screenshotted per viewport | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Two conflicting sources of truth for the same foundation | High |
| No spacing or type scale declared anywhere — every value ad hoc | High |
| A theme declared but only partially covered | High |
| Token adoption below ~50% in a category | Medium |
| Duplicate implementations of one component that have diverged | Medium |
| Variant logic inline instead of centralised | Medium |
| Off-scale one-off values in a minority of components | Medium |
| No merge helper for conditional classes | Medium |
| Unbounded z-index set | Medium |
| Redundant near-identical tokens | Low |
| Semantic token named after its value | Low |
| Token lint rule declared but not run in CI | Low |
