# UX review protocol

## Choosing tasks

Rank candidate tasks on three axes and keep the top 3-5:

- **Frequency**: how often a typical user does it.
- **Importance**: how much the product goal depends on it.
- **Cost of failure**: what is lost when it goes wrong (data, money, time, trust).

Write each task as a goal the user would state, never as a route.

- Good: "Upload the math guide to Unit 2 and confirm it landed in the right folder."
- Bad: "Click Upload, choose Unit 2, press Save."

For every task also walk:

- the wrong-choice path (wrong folder, wrong item, wrong recipient), and how the user notices and undoes it;
- the failure path (network error, validation error, timeout, missing permission), and how the user recovers without losing work;
- the return visit: can the user find the result again later?

## Walking a task

Record per step: screen, what the user must decide, what changed in state, alternate routes, and the signal that tells the user the task is done. Screenshot every step. On web, also note console errors and failed requests seen along the way.

## The four levels

### 1. Information architecture

- Do labels use the user's words, not internal or technical ones?
- Can the user predict where something lives before clicking?
- Is content grouped the way the user thinks about it?
- On return, can the user reorient: where am I, how did I get here, where can I go?
- Do search, filters and sorting match how people look for things?

### 2. Interaction

- Is it clear what can be done here, and what each control does before using it?
- While the system works, does the user see that it is working and roughly for how long?
- After an action, is the result visible and unambiguous?
- Repeated input: does the user retype data the system already has?
- Lost progress: do navigation, refresh, timeout or an error wipe what was entered?
- Irreversible actions: are they confirmed in proportion to their cost, or better, undoable?
- Errors: does the message say what happened, why, and how to fix it, next to where it happened, keeping the input?

### 3. Visual composition

- Reading order: does the eye land first on what matters at this step?
- Hierarchy: is the primary action unmistakable, with secondary actions quieter?
- Grouping and density: are related items together, unrelated ones apart, with nothing crammed or scattered?
- Alignment, type scale, contrast and copy: consistent with the design system, readable, and specific?
- Responsive: on mobile, does the priority order survive, and are actions reachable?
- For each screen, name what should move up, move down, be grouped, moved, removed or shown on demand.

### 4. Accessibility and integration

WCAG 2.2 AA criteria to check at minimum:

- 1.4.3 contrast;
- 1.4.11 non-text contrast;
- 2.1.1 keyboard;
- 2.4.3 focus order;
- 2.4.7 focus visible;
- 2.4.11 focus not obscured;
- 2.5.8 target size, at least 24x24 CSS px;
- 3.3.1 error identification;
- 3.3.2 labels or instructions;
- 3.3.7 redundant entry;
- 3.3.8 accessible authentication;
- 4.1.2 name, role, value.

Integration: do the patterns hold together across these conditions?

- roles and permissions, including a user who lacks permission;
- states: loading, empty, error, success, partial;
- data volume: none, one, typical, and very many items, long text, long names.

## Evidence types

Label every major finding with one of these:

| Type | Use when |
|------|----------|
| Product observation | You reproduced it in the app; cite screenshot, step, state |
| Product data | Sessions, analytics, interviews, tickets or usability tests exist; cite them |
| External research | A published study supports it; say what it studied, what it found, how its context resembles ours |
| Accessibility criterion | A WCAG 2.2 success criterion applies; cite its number |
| Heuristic | A Nielsen Norman Group heuristic applies; name it |
| Hypothesis | None of the above; write it so a test can confirm or refute it |

## Sources

Use these to guide the inspection and back the findings. Link to the original source.

| Source | Use it for |
|--------|------------|
| Nielsen Norman Group, 10 usability heuristics | Guiding the inspection |
| WCAG 2.2 | Accessibility criteria |
| Google's HEART framework | Linking goals to signals and metrics when useful |
| Baymard Institute | Checkout and e-commerce flows |
| The equivalent empirical source for other domains | Forms, onboarding, search, dashboards, and so on |

Prefer primary studies over summaries, and never quote a number you did not read in the source.
