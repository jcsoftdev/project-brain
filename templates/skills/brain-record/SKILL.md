---
name: brain-record
description: "Trigger: record a demo, graba el flujo, demo del branch, gif de la feature, video del PR, evidence video for PR, ticket attachment video, swagger walkthrough recording, record this flow, video del ticket, grabar evidencia, screen recording of this work. Records the full flow a ticket or branch touches — frontend through the browser, backend through Swagger UI — at a true, real-time-paced 30fps with a drawn pointer overlay, as evidence for a PR or ticket attachment."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "2.0"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->

## Why this engine, not screen capture

The previous engine drove the browser through the Chrome MCP and captured the SCREEN
with `ffmpeg -f avfoundation`. That cannot work, and this was verified live, not
reasoned: the Chrome MCP drives a tab that is NOT frontmost, so the page reports
`visibilityState: "hidden"`, `hasFocus: false`, and therefore `outerWidth: 0,
outerHeight: 0, screenX: 0, screenY: 0` — an instruction to "read the window rect from
the page" returns zeros. Worse, screen capture records the FOREGROUND, which is a
different tab entirely; capturing one frame of every attached display confirmed the
automated page was on neither. Screen capture and a background-tab driver are
structurally incompatible.

This engine drives the browser AND captures it over the same channel: Chrome DevTools
Protocol. `assets/record.mjs` connects to a Chrome instance's CDP endpoint with
`playwright-core`, drives every beat itself (click, fill, scroll), and captures with
`Page.startScreencast`, which captures the PAGE regardless of foreground state or tab
visibility. There is no more Chrome MCP involvement in the recorded take at all — see
Execution Steps for where Chrome MCP still helps (page inspection only, never the take
itself) and where it does not appear.

One consequence worth stating plainly: this engine has no macOS dependency. The old one
needed `avfoundation`, which is macOS-only. This one needs Chrome, Node, and ffmpeg —
available on any platform that runs project-brain.

## Activation Contract

Apply when asked to record a video of the full flow a ticket or branch touches, as
evidence for a PR review or a ticket attachment — a frontend flow driven in the
browser, a backend flow driven through Swagger UI, or both in one take.

This skill owns BOTH weights of that job. A handful of states is not a different skill,
it is the light gate below: `gif_creator` needs no worktree, no ffmpeg, no node and no
playwright. Choosing between them is a Decision Gate, not a hand-off.

Do not apply when: the branch has no user-visible flow to show (a refactor that touches
no route or endpoint); or no Chrome binary is reachable and the user cannot enable
remote debugging on any Chrome instance — say so and stop, do not attempt a degraded
capture.

## Hard Rules

- Never drive the recorded take through the Chrome MCP. Verified live: a tab under
  `computer`/`navigate` control is not frontmost, reports `visibilityState: "hidden"`
  and a zeroed window rect, and a screen-capture engine built on that data captures the
  wrong tab. Always drive the take through `assets/record.mjs`, connected directly to a
  Chrome instance's CDP endpoint, and capture with `Page.startScreencast` — it captures
  the PAGE, so foreground and tab visibility never matter. Chrome MCP tools
  (`navigate`, `read_page`, `find`) may still be used to INSPECT the app while deriving
  beats — that exploration is never part of the recording.
- Never run `assets/record.mjs` under `bun`. Measured: `chromium.connectOverCDP` from
  Bun hangs at the websocket upgrade and dies at the 30s timeout, while the identical
  script under `node` connects instantly. Always `node assets/record.mjs ...` — see
  Decision Gates and `references/pitfalls.md`.
- Never assume `NODE_PATH` or `npx --package=playwright-core` makes `import { chromium }
  from "playwright-core"` resolve. Measured: both fail with `ERR_MODULE_NOT_FOUND`,
  because Node's ESM resolver walks up `node_modules` from the FILE doing the import,
  not from `cwd` or `PATH`. Always run `record.mjs` from inside (copied into, or
  symlinked under) the scratch directory that owns `node_modules/playwright-core` — see
  Execution Steps.
- Never accept a consent/cookie overlay on the user's behalf. Sweep it away GENERICALLY
  (any `position: fixed|sticky` element with `z-index > 1000` covering more than 25% of
  the viewport, excluding the pointer) — never by a vendor selector. Two runs against
  the SAME url served two different consent libraries. REMOVE, never ACCEPT: clicking
  "allow all" is consent this tool has no standing to give, and it would be recorded as
  if the user had agreed. Re-run the sweep after every scroll.
- Never press a button that writes real data unless the user explicitly asked for that
  beat to be real. Prefer read paths, cancel confirmations before they submit, or a
  sandbox/staging environment when a beat would otherwise mutate real data.
- Never ship a GIF. Measured: a GIF of the same take is LARGER than the H.264 MP4 while
  carrying fewer frames, lower resolution and 256 colours. One output, one format —
  `build-video.sh` writes it. Drag the MP4 into the pull request; GitHub renders a
  player.
- Never hardcode the app's own port. Acquire it with `port_acquire` using the
  `project`/`worktree` pair `project-brain worktree status --json` reports — two agents
  that both assume 3000 collide, and it looks like a broken app. The CDP port is a
  different concern (which Chrome instance to attach to, not which port the app under
  test binds) — see Decision Gates for how it is chosen.
- Never default the connection mode to "live". `project-brain setup` records a
  preference (`~/.project-brain/record-config.json`), and it defaults to "fresh" and
  stays there unless the user explicitly opted in with `--record-connection-live`.
  Chrome's own warning on the toggle "live" requires is the honest cost — see Decision
  Gates.
- Derive beats in the MAIN checkout; record in the WORKTREE. `.project-brain/` only
  resolves in the main checkout — deriving beats from an uninitialized worktree returns
  nothing.
- Delete raw frames (`frames/`) and any scratch concat file once the final MP4 is
  built. A take is tens of megabytes of JPEGs.

## What has actually been recorded, and what has not

Stated because a skill that hides its own coverage costs its first user an afternoon.

VERIFIED end to end on real hardware: the backend path. A Swagger UI flow driven over
CDP — expand an operation, Try it out, fill a required parameter, Execute — recorded to a
1280x800 constant-30fps MP4 whose last frame carries the request URL and a 200. Fresh
throwaway profile.

NOT YET VERIFIED, in this order of risk:
- The FRONTEND path. Same engine and same beats, but no real application flow with
  navigation, forms and state has been recorded through it. Treat the first frontend take
  as a shakedown: check the file before promising it to a reviewer.
- Connection mode "live". Wired and documented, never run against a logged-in Chrome.
- The light `gif_creator` gate, inherited from `branch-demo` rather than re-measured here.

## Decision Gates

| Situation | Do |
|---|---|
| Fewer than ~8 states worth showing, and none of them is motion (a scroll, a transition, a drag) | Light path: `gif_creator`. Discrete screenshots, no worktree, no ffmpeg, no node. See the cap and the overlay settings in `references/pitfalls.md` before using it |
| Anything with motion, or more than ~8 states | Full path: `record.mjs` + `build-video.sh`. `gif_creator` physically cannot show motion — one frame per action — and caps at 50 frames SILENTLY |
| Flow is pure frontend (routes/components changed) | Beats target the app directly |
| Flow is pure backend (handler/controller/route changed, no UI) | Beats target Swagger UI (`/api-docs`, `/swagger`, or whatever the project serves) against the same endpoint |
| Flow touches both | One take, ordered the way the ticket describes it — e.g. the frontend action, then the backend call it triggers in Swagger UI |
| No worktree yet, or `worktree status` reports `indexed: false` | Defer to `brain-worktree` to create and index it — never `git worktree add` by hand |
| A beat would mutate real data | Confirm with the user first, or record up to the confirming dialog and stop there |
| No connection-mode preference recorded yet | Read `~/.project-brain/record-config.json` (written by `project-brain setup`); if absent, default to `{ mode: "fresh", cdpPort: 9222 }` — never assume "live" |
| Connection mode is "fresh" | Launch a throwaway Chrome (`--remote-debugging-port=<cdpPort> --user-data-dir=<tempdir>`), poll `/json/version` until it answers, record, then kill that Chrome process and delete its temp profile |
| Connection mode is "live" | The USER opens `chrome://inspect/#remote-debugging` in their own Chrome and toggles "Allow remote debugging for this browser instance" themselves — never automate that toggle. Surface Chrome's own warning before proceeding (quoted in full in Execution Steps). Never launch or kill the user's Chrome process |
| `record.mjs` throws a click-guard error (`"<label>": "<X>" is on top at <x>,<y> — a click here would hit that, not the target`) | Stop. Do not retry blindly — either the beat's selector needs a different scroll target, or a new kind of overlay needs investigating (never hardcode it into the sweep by vendor) |
| The CDP port is unreachable, or `/json/version` answers but the flow's tab is not there | Ask the user, or pick a different `--record-cdp-port` — never silently reuse a port that might be a stray Chrome from a previous take |

## Execution Steps

### Phase 0 — Ask exactly one thing, and only when you must

Infer everything you can; ask only what the repository cannot tell you.

Inferable from the diff, so never ask: frontend or backend (routes and components mean
the app, handlers and endpoints mean Swagger UI), light or full path (count the states
worth showing, and whether any of them is motion), which base branch to diff against.

NOT inferable, so this is the one question: **does the flow need a logged-in session?**
A flow behind auth needs connection mode "live" — the user's own Chrome, with their
cookies. Everything else records on a throwaway profile. Nothing in the diff answers
that, and guessing "live" wrongly means asking someone to expose their whole browser.

Ask it as one question, phrased for a decision and not for a menu, and only when the
recorded config does not already answer it. Then stop and wait. Do not stack a second
question onto it, and do not ask at all when the flow is plainly public — a Swagger UI
served by the branch's own dev server needs no session.

### Phase 1 — Derive beats (run in the MAIN checkout)

1. Resolve the ticket/branch: use the argument if given, else the current branch
   (`git branch --show-current`).
2. Read what it touches: `git diff <base>...<branch> --stat`, then the full diff for the
   changed symbols. Use whichever base the repo actually branches from (`main`,
   `develop`, …).
3. Map files to user-visible surface with project-brain, from the MAIN checkout — this is
   why phase 1 cannot run from the worktree, `.project-brain/` only resolves here:
   - Frontend files → `find_callers`/`trace_path` to the route/page that renders them, or
     `search_context` for "route for `<component>`" when the mapping isn't obvious from
     the path alone.
   - Backend files → `find_symbol` on the changed handler/controller to get its exact
     HTTP method + path — that is the operation to drive in Swagger UI.
4. Write the beats as an ordered list of concrete actions, not vague states. Each beat
   names a URL or Swagger operation, an interaction, and what proves it worked:
   ```
   1. Navigate to /login, sign in as the demo user
   2. Navigate to /orders/new, fill quantity=3, submit
   3. Swagger UI: POST /api/orders — show the 201 response body with the new order id
   4. Navigate to /orders, show the new order in the list
   ```
5. Keep this list in context as the shot list for phase 2 — nothing here needs to survive
   to disk. The same session carries it across the working-directory switch.

### Phase 2 — Record (run in the WORKTREE)

6. Ensure the worktree exists and is indexed — follow `brain-worktree`'s own steps rather
   than reimplementing worktree creation or `project-brain init`/`sync` here. Use
   `EnterWorktree` (or the `using-git-worktrees` skill) to enter it.
7. Acquire the port(s) the beats need: read `project-brain worktree status --json` for
   the `project`/`worktree` pair, then `port_acquire(project, worktree, technology)` once
   per service (e.g. `frontend`, `backend`). Start the app(s) bound to the acquired
   ports — never a hardcoded one.
8. Find each beat's selector. Navigate the running app with Chrome MCP
   (`mcp__claude-in-chrome__navigate`, `read_page`, `find`) purely to INSPECT it — prefer
   an id, a `data-testid`, or a stable ARIA role/name over a structural CSS path. This
   exploration never touches CDP directly and is not part of the recording; close or
   ignore that tab once every beat has a selector.
9. Write `flow.json` (anywhere in the worktree's scratch area) from phase 1's shot list,
   translated into `record.mjs`'s beat shapes:
   ```json
   {
     "startUrl": "http://localhost:<port>/orders/new",
     "viewport": { "width": 1280, "height": 800 },
     "beats": [
       { "action": "click", "label": "expand GET /pet/findByStatus", "selector": "#operations-pet-findPetsByStatus .opblock-summary-control" },
       { "action": "click", "label": "Try it out", "selector": "#operations-pet-findPetsByStatus .try-out__btn" },
       { "action": "fill", "label": "choose status=available", "selector": "#operations-pet-findPetsByStatus select", "value": "available" },
       { "action": "click", "label": "Execute", "selector": "#operations-pet-findPetsByStatus .execute" },
       { "action": "wait", "ms": 1600 },
       { "action": "centre", "label": "show the response", "selector": "#operations-pet-findPetsByStatus .live-responses-table", "ms": 900 }
     ]
   }
   ```
   The clickable header of a Swagger operation is the summary CONTROL, not the whole
   `opblock` — the `opblock`'s box centre falls below the header once it expands, so a
   click at its centre misses. A backend-only beat sequence targets the Swagger UI URL
   as `startUrl` instead of the app's own route.
10. Resolve the connection mode and CDP endpoint per the Decision Gates row:
    - **Fresh** (default, safe — what this engine was verified against):
      ```
      PORT=<cdpPort from record-config.json, default 9222>
      PROFILE=$(mktemp -d)
      "<Chrome binary>" --remote-debugging-port=$PORT --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check about:blank &
      until curl -s -o /dev/null http://127.0.0.1:$PORT/json/version; do sleep 0.05; done
      ```
      Poll `/json/version` rather than sleeping a fixed guess — measured ~0.7s on one
      machine for a headless launch, but do not assume that number holds everywhere; see
      `references/pitfalls.md`. `--headless=new` is optional: drop it to watch the take
      live, keep it on a machine with no display. No logins, no cookies, no history — a
      throwaway profile is inherently safe to record.
    - **Live**: the USER — never this skill — opens `chrome://inspect/#remote-debugging`
      in their own already-running Chrome and toggles "Allow remote debugging for this
      browser instance" themselves. Before asking them to, surface Chrome's own warning
      verbatim, because it is the honest cost of this mode: it "allows external apps to
      request full control of this browser. This includes read access to your saved
      data, cookies and site data, and the ability to navigate to any URL." Confirm the
      user understands that before using this mode, even if `record-config.json` already
      says `"mode": "live"` — a stored preference is not a renewed consent for THIS take.
      Use the CDP port Chrome itself reports once the toggle is on; it does not have to
      match `record-config.json`'s stored default.
11. Resolve `playwright-core` without adding it as a project-brain dependency. Cache the
    install once, globally, and run `record.mjs` from inside that cache directory —
    verified this is required, not optional, per the Hard Rules item on `NODE_PATH`:
    ```
    SCRATCH="$HOME/.project-brain/record-scratch"
    mkdir -p "$SCRATCH"
    [ -d "$SCRATCH/node_modules/playwright-core" ] || npm install --prefix "$SCRATCH" --no-save playwright-core
    cp assets/record.mjs "$SCRATCH/record.mjs"
    ```
12. Run the take:
    ```
    node "$SCRATCH/record.mjs" <outdir> <flow.json path> http://127.0.0.1:$PORT
    ```
    in the FOREGROUND — unlike the old engine, there is no separate capture process to
    interleave `computer` calls with. `record.mjs` drives every beat itself and only
    returns once the whole flow is complete, printing `beat: ...` lines as it goes and a
    final `frames=N span=Xs` line. A non-zero exit means a beat failed (most likely the
    click guard) — read the error, fix the flow, and re-run rather than trying to salvage
    a partial take.
13. Build the deliverable:
    ```
    bash assets/build-video.sh <outdir>/frames <outdir>/stamps.json <out.mp4>
    ```
14. Sample the finished file across its length and look at it. `build-video.sh` prints a
    ready-made sampling command in its own output — scoring is not the same as watching
    what shipped.
15. Clean up: delete `frames/` and `stamps.json`. In fresh mode, kill the Chrome process
    launched in step 10 and delete its temp profile directory — in live mode, leave the
    user's Chrome exactly as it was, just stop connecting to it. `port_release` the
    app's leased ports and tear down the worktree per `brain-worktree`'s own teardown
    step, unless the user wants it left open for another pass.

## Output Contract

Report: the beats recorded (from phase 1, and the selectors phase 2 resolved them to);
the worktree used and whether it was created or reused; the app port(s) leased and their
technology; the connection mode used (fresh or live) and the CDP port; if fresh, that the
throwaway profile and Chrome process were cleaned up; if live, that the user (not this
skill) enabled and will disable remote debugging; `record.mjs`'s own `frames=N span=Xs`
line; the output file's path, size, and duration; and whether `frames/`/`stamps.json`
were deleted. If any beat could not be captured cleanly — a click-guard failure, a button
that would have mutated real data, a connection that never came up — say so explicitly
rather than shipping a take with the caveat buried in prose.

## References

- `assets/record.mjs` — connects to a Chrome CDP endpoint with `playwright-core`, drives
  a `flow.json`'s beats (click/fill/centre/wait) with a drawn pointer overlay and a
  generic consent-overlay sweep, and captures via `Page.startScreencast` — writing
  `frames/NNNNN.jpg` and `stamps.json` (per-frame real timestamps). Run with `node`,
  never `bun`; see its own header comment for why.
- `assets/build-video.sh` — turns `stamps.json` into an ffmpeg concat file with a
  per-frame `duration`, then encodes a constant fps=30 H.264 MP4. No browser-chrome crop
  — the screencast never contained one.
- `references/pitfalls.md` — traps to read before the first take, each labelled measured
  or derived.
