# Flow Integrity

Does each user-visible flow actually complete? Reachability asks whether code runs at all; this module asks whether a flow that runs ever *finishes*. Half-wired features pass every type check and every unit test — they only fail a user.

Trace each flow end to end with `trace_path` from the entry point (button, command, route, event) to its terminal effect (write, response, navigation, render). A flow with no proven terminal effect is the finding.

## Orphan UI

- [ ] Handlers wired to nothing: `onClick={() => {}}`, `onSubmit` with an empty body, `href="#"`, `TODO` / `FIXME` inside a handler.
- [ ] Buttons and menu items whose handler navigates to a route that does not exist, or opens a modal never rendered.
- [ ] Forms whose submit handler validates and then returns without calling anything.
- [ ] Controls disabled unconditionally, or rendered behind a condition that is never true.
- [ ] Keyboard shortcuts and context-menu entries registered but bound to no action.

## Flows with no terminal state

For every flow the user can start, confirm it can end:

- [ ] **Submit into the void** — the request fires and nothing consumes the response.
- [ ] **Success with no feedback** — the operation succeeds and the UI never says so. The user retries; now you have a duplicate-write bug.
- [ ] **Unhandled error path** — `catch` that swallows, `.catch(() => {})`, an error state the UI cannot render.
- [ ] **No cancel / no back** — a multi-step flow the user cannot exit without losing everything.
- [ ] **No timeout** — an in-flight operation that can hang forever with the UI stuck in loading.
- [ ] **Missing confirmation on destructive actions** — delete/overwrite/reset with no interstitial.

## Half-wired features

Each of these is a pair where only one half exists. Prove the counterpart with `find_callers` / `trace_path`, not by eyeballing directory names.

| One half exists | Missing counterpart | Typical severity |
|---|---|---|
| Backend endpoint | No UI or client calls it | Medium |
| UI component | No backend to serve it | High |
| Migration creates a column | No code ever reads or writes it | Low → Medium |
| Code reads a column | No migration creates it | Critical |
| Event emitted | No listener subscribed | Medium |
| Listener subscribed | No emitter | Low |
| Job enqueued | No worker consumes that queue | High |
| Worker consuming a queue | Nothing ever enqueues to it | Medium |
| Config option accepted | No code branches on it | Low |
| Webhook receiver | Never registered with the provider | High |

## The loading / empty / error triad

Every view that fetches data needs three states beyond the happy path. Missing any one is a real defect, not polish.

- [ ] **Loading** — is there an indicator, or does the screen sit blank while the request is in flight?
- [ ] **Empty** — zero results renders as deliberate empty state, not as a broken-looking blank list or a crash on `data[0]`.
- [ ] **Error** — the failure renders something actionable, with a retry where retrying is meaningful.
- [ ] The three states are mutually exclusive and reachable — no combination that renders both a spinner and an empty state.

## Cross-cutting

- [ ] Optimistic updates have a rollback path when the request fails.
- [ ] Multi-step flows survive a page reload, or explicitly warn before losing progress.
- [ ] Every flow that writes has a corresponding way to read the result back.
- [ ] Authenticated flows handle session expiry mid-flow rather than failing at the final step.

## Reporting

Report each broken flow as a path, not a symptom: `entry point (file:line) → … → dead end (file:line)`. State which step is missing and what the user experiences when they hit it. That is the difference between "this looks unfinished" and a finding someone can fix.
