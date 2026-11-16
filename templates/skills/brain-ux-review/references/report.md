# UX review report

Write the report in the user's language. Product copy you propose follows the product's language and register.

## 0. Context and assumptions

Product and access, users and roles, priority tasks, product goal, design system, scope (app, feature, screen), mode (audit, redesign, implement). List every assumption you made.

## 1. Task map

| # | Task (user goal) | User / role | Entry point | Success criterion | Why chosen (frequency, importance, cost of failure) |
|---|------------------|-------------|-------------|-------------------|------------------------------------------------------|

## 2. Findings

| ID | Task / step | Screen and state | Problem (what the user tried, what happened) | Evidence (type + pointer) | Reproduced | Impact | Effort | Priority |
|----|-------------|------------------|-----------------------------------------------|---------------------------|------------|--------|--------|----------|

Classify impact into one of three classes:

- **Blocker**: the user cannot finish the task, or loses data or money.
- **Recoverable friction**: the user finishes, but with errors, retries, detours or doubt.
- **Visual adjustment**: the task works, but the layout, hierarchy or copy slows reading or hides the action.

- **Effort**: S (under a day), M (a few days), L (more than a week).
- **Priority**: impact first, then effort.

## 3. Proposed flows

For each priority task, show the current journey and the proposed one as step lists. Add before/after wireframes for the major changes when you can draw them, as ASCII, an HTML mock or screenshots.

For each screen that changes, specify:

- **First read**: what the user must recognize first, and the order of the content.
- **Primary action**: which one, where it sits, and its exact label.
- **Grouping**: what to group, move, remove or show on demand.
- **Mobile**: how the composition adapts and what stays above the fold.
- **States**: the behavior in loading, empty, error, success and no-permission, as applicable.
- **System**: the components and tokens reused, and any kit extension, only for a pattern that repeats.
- **Why**: how this makes the task easier, tied to finding IDs.

## 4. Validation plan

For each flow:

- **Hypothesis**: "If <change>, then <metric> moves toward <direction>, because <finding>."
- **Scenario**: a realistic goal that does not reveal the route.
- **Success criterion**: what counts as done without help.
- **Metrics**: pick only those that answer the hypothesis: unaided completion rate, time to complete, errors, retries, drop-off by step. Map them to HEART when useful.
- **Baseline**: how to measure the current flow before attributing any change to the redesign. Use the same scenario and the same metric, with the same kind of participants, or analytics over a fixed window.

### Writing test scenarios

- Give the user a goal and a reason, not a route. Example: "You need the Unit 2 math guide available to students before Monday."
- Do not use the words of the UI labels you are testing.
- Write one goal per scenario, with an end state the participant can recognize.

## 5. Verification status

| Item | Checked in the app | Needs user testing | Data missing for before/after |
|------|--------------------|--------------------|-------------------------------|

In implement mode, add each re-walked task with its before and after evidence, and say which findings are verified, partly verified or not addressed.
