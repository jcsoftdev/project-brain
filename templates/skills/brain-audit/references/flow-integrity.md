# Flow Integrity

Does each user-visible flow actually complete? Reachability asks whether code runs at all; this module asks whether a flow that runs ever *finishes*. Half-wired features pass every type check and every unit test — they only fail a user.

Trace each flow end to end with `trace_path` from the entry point (button, command, route, event) to its terminal effect (write, response, navigation, render). A flow with no proven terminal effect is the finding.

## Orphan UI

- [ ] Handlers wired to nothing — `search_code` for the literal patterns `onClick={() => {}}`, `onSubmit={() => {}}`, `href="#"`, and `TODO`/`FIXME` co-located with a handler name. Read the surrounding component before reporting, to rule out a deliberately no-op control (a disabled preview, a placeholder in an unreleased section).
- [ ] Buttons and menu items whose handler navigates to a route that does not exist, or opens a modal never rendered — `search_code` the route or path string passed to the navigation call, then `find_symbol` for a matching route definition; for a modal, `find_callers` on its render to confirm something actually mounts it.
- [ ] Forms whose submit handler validates and then returns without calling anything — `find_callees` on the submit handler. A call list that ends at the validator with no request or dispatch call after it is the finding.
- [ ] Controls disabled unconditionally, or rendered behind a condition that is never true — `search_code` for `disabled={true}` or `disabled` as a bare boolean literal, and read the guarding condition for a constant that can never evaluate true.
- [ ] Keyboard shortcuts and context-menu entries registered but bound to no action — `search_code` the shortcut-registration call (`useHotkeys`, `addEventListener('keydown'`, a context-menu config array), then `find_callees` on the bound callback.

## Flows with no terminal state

For every flow the user can start, confirm it can end:

- [ ] **Submit into the void** — `trace_path` from the request-firing call to any consumer of its response or promise. No path found is the finding. Rule out a request whose own documentation or naming marks it as intentionally fire-and-forget (an analytics beacon, a best-effort "mark as read" ping) before flagging.
- [ ] **Success with no feedback** — `find_callees` on the success branch (`.then`, `onSuccess`); no call to a toast, notification, or state-update function after the write means success is silent. The user retries; now you have a duplicate-write bug.
- [ ] **Unhandled error path** — `search_code` for `catch {}`, `.catch(() => {})`, and a `catch` block that only logs — an error state the UI cannot render.
- [ ] **No cancel / no back** — `Read` the multi-step flow's component tree for a cancel or back handler; its absence alongside a wizard/stepper component is the finding.
- [ ] **No timeout** — `search_code` the request call (`fetch(`, the HTTP client instance) and confirm a timeout or abort-controller is attached. None found means the UI can hang in loading indefinitely.
- [ ] **Missing confirmation on destructive actions** — `search_code` the delete/reset/overwrite handler, then `find_callees` to confirm a confirmation-dialog component is invoked *before* the mutating call, not merely rendered somewhere else in the tree.

## Half-wired features

Each of these is a pair where only one half exists. Prove the counterpart with the paired calls below, not by eyeballing directory names.

| One half exists | Missing counterpart | Probe | Typical severity |
|---|---|---|---|
| Backend endpoint | No UI or client calls it | `search_code` the route path in client code; `find_callers` on the handler | Medium |
| UI component | No backend to serve it | `find_callees` on the component's submit/fetch call; `search_code` the target path server-side | High |
| Migration creates a column | No code ever reads or writes it | `search_code` the column name across query and model code | Low → Medium |
| Code reads a column | No migration creates it | `search_code` the column name across every migration file; `find_callers` on the reading code to confirm it sits on a live, reachable path | High → Critical (traced) |
| Event emitted | No listener subscribed | `find_callers` on the emit call; `search_code` the event name in subscription code | Medium |
| Listener subscribed | No emitter | `search_code` the event name for any `.emit(`/`dispatch(` call site | Low |
| Job enqueued | No worker consumes that queue | `search_code` the queue name in worker registration | High |
| Worker consuming a queue | Nothing ever enqueues to it | `search_code` the queue name at every enqueue call site | Medium |
| Config option accepted | No code branches on it | `find_callers` on the config field access | Low |
| Webhook receiver | Never registered with the provider | `search_code` the webhook URL/path in provider setup, deploy config, or admin notes | High |

## The loading / empty / error triad

Every view that fetches data needs three states beyond the happy path. Missing any one is a real defect, not polish.

- [ ] **Loading** — `search_code` the fetch/query hook usage (`useQuery`, `isLoading`) in the view and read the render for a loading branch; its absence means the screen sits blank while the request is in flight.
- [ ] **Empty** — `search_code` the render of the list/collection and confirm a zero-length branch exists before the item map; a bare `.map()` with no guard renders a broken-looking blank list or crashes on `data[0]`.
- [ ] **Error** — `search_code` the same hook's error state (`isError`, `error`) and confirm it renders an actionable message with a retry where retrying is meaningful, not just a console log.
- [ ] The three states are mutually exclusive and reachable — `Read` the conditional rendering order; overlapping conditions (an `isLoading` check that doesn't exclude `isEmpty`) let two states render at once.

## Cross-cutting

- [ ] Optimistic updates have a rollback path when the request fails — `find_callees` on the optimistic-update function; the error branch needs a rollback/revert call, not just a log.
- [ ] Multi-step flows survive a page reload, or explicitly warn before losing progress — `search_code` for persisted step state (`sessionStorage`, `localStorage`, a URL param) or a `beforeunload` handler. Absence of both is the finding.
- [ ] Every flow that writes has a corresponding way to read the result back — `search_code` a GET/query counterpart to each mutating endpoint or dispatch.
- [ ] Authenticated flows handle session expiry mid-flow rather than failing at the final step — `search_code` for a 401/expired-session interceptor and confirm it is wired into the same client used by long-running flows, not only the initial page load.

## Out of static reach

- Whether the loading/error UI actually renders correctly at runtime — this module proves the branch exists, not that it looks right or fires in time.
- Timing-dependent races between an optimistic update and the server's real response under real network latency.
- Whether a confirmation dialog is easy to dismiss accidentally, or whether users read it before clicking through.
- Session-expiry handling that depends on server-side token lifetimes not visible from source.
- Whether an event with no in-repo listener is consumed by a downstream service, browser extension, or webhook subscriber outside this repo.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether the loading/error UI actually renders correctly at runtime, versus merely proving the branch exists in source | High |
| `network.jsonl` | Timing-dependent race between an optimistic update and the server's real response — bounded to the single observed timing, not eliminated as a possibility | Medium |
| `steps.md` | Orphan control confirmed: a control clicked during a walked flow produced no request and no DOM/state change | High |

## Reporting

Report each broken flow as a path, not a symptom: `entry point (file:line) → … → dead end (file:line)`. State which step is missing and what the user experiences when they hit it. That is the difference between "this looks unfinished" and a finding someone can fix.

## Severity guidance

| Situation | Severity |
|---|---|
| Client calls an endpoint that does not exist, established by `search_code` for the route path server-side | High |
| Code reads a column no migration creates, `find_callers`-traced to a live, reachable call site | Critical |
| Code reads a column no migration creates, established only by the migration-file `search_code` | High |
| UI component with no backend to serve it | High |
| Webhook receiver never registered with the provider | High |
| Job enqueued with no worker consuming the queue | High |
| Unhandled error path swallowed silently | High |
| Success with no feedback, risking a duplicate-write retry | Medium |
| Missing loading, empty, or error state on a data view | Medium |
| Handler wired to nothing (orphan UI) | Medium |
| Backend endpoint with no caller | Medium |
| Optimistic update with no rollback path | Medium |
| Config option accepted but nothing branches on it | Low |
| Listener subscribed with no emitter | Low |
