# Traps, with the numbers that produced them

Every screen-capture pitfall from the previous engine (`CGWindowListCopyWindowInfo`,
avfoundation device matching, HiDPI logical-vs-physical pixel math, browser-chrome crop,
foreign-window frame filtering) is gone from this file. Not trimmed for length — gone
because the mechanism that produced every one of them is gone: this engine captures the
PAGE over CDP (`Page.startScreencast`), and a page screencast cannot contain a frame of
another window, cannot be affected by which display the browser is on, and has no OS
window chrome in it to crop. Each item below is labelled measured or derived; several
were reproduced directly while building this rewrite, on this machine, and say so.

## Screen capture and a background-tab driver are structurally incompatible [measured]

The finding that forced this rewrite. The Chrome MCP drives a tab that is NOT
frontmost — verified live: the page reported `visibilityState: "hidden"`, `hasFocus:
false`, and therefore `window.screenX/screenY/outerWidth/outerHeight` were all `0`. An
engine whose central instruction was "read the window rect from the page" got zeros, and
a 0×0 crop is not a recoverable degraded case. Separately, screen capture records the
FOREGROUND — capturing one frame of each attached display confirmed the automated page
was on neither. `Page.startScreencast` captures the page itself, so neither fact matters
any more.

## node, never bun [measured]

`chromium.connectOverCDP` from Bun hangs at the websocket upgrade and dies at the 30s
timeout. A plain HTTP GET to `/json/version` from the same Bun process succeeds
instantly — so the failure is specific to Bun's websocket client during the CDP
handshake, not to reaching the port at all. The identical script under `node` connects
immediately. Always invoke `assets/record.mjs` with `node`.

## `NODE_PATH` and `npx --package` do NOT make `playwright-core` resolve [measured]

Reproduced directly while building this rewrite, on Node 26.7.0. Both of these fail with
`ERR_MODULE_NOT_FOUND: Cannot find package 'playwright-core' imported from
.../record.mjs`:

```
NODE_PATH=$SCRATCH/node_modules node assets/record.mjs ...
npx --package=playwright-core -- node assets/record.mjs ...
```

The reason: Node's ESM resolver walks up `node_modules` directories starting from the
importING file's own path — `NODE_PATH` is a legacy mechanism the ESM loader does not
consult at all, and `npx --package` puts the installed package on `PATH`/makes its bins
runnable, but does not change where `record.mjs`'s own `import` statement looks. The fix
that was verified to work: copy (or symlink) `record.mjs` INTO the directory that owns
`node_modules/playwright-core` before running it —

```
cp assets/record.mjs "$SCRATCH/record.mjs"
node "$SCRATCH/record.mjs" <outdir> <flow.json> <cdpUrl>
```

— so Node's own upward walk from the script's location finds it. Do not "simplify" this
back to `NODE_PATH` or a bare `npx` invocation; both were tried first and both fail.

## The screencast is variable-rate — idle time produces zero frames [measured]

Reproduced on a real smoke-test flow (a local static page, two beats: a click and a
select-fill). `stamps.json` came back as 117 entries; the run of consecutive deltas
included one gap of `1.5517 - 1.2906 ≈ 0.261s` with no frame in between — a stretch where
the page was not repainting (a settle wait between beats). `Page.startScreencast` only
emits a frame when the page's compositor actually produces one; it is not a fixed-rate
tap. `assets/build-video.sh` exists specifically to turn this variable-rate sequence,
via `stamps.json`, into a normal constant-rate file — never encode the raw frame sequence
at a flat input `-framerate`, which would play back faster than real time across any gap
like the one above.

## Fresh-Chrome launch is not instant, but it is fast [measured]

Timed directly: `chrome --headless=new --remote-debugging-port=<n>
--user-data-dir=<fresh tmp dir>` took **0.73s** on this machine before `/json/version`
answered. Poll for it (`until curl -s ... ; do sleep 0.05; done`) rather than sleeping a
fixed guess — the old engine's ~2.7s avfoundation-probe number no longer applies at all
(there is nothing to probe: no device enumeration, no multi-display matching), but a
single measurement on one machine is not a promise for every machine either.

## Consent overlays: sweep generically, verified working [measured]

Reproduced on the same smoke-test flow: a synthetic full-viewport `position: fixed;
z-index: 99999` banner covering 75% of the viewport was swept before the screencast
started, logged as `overlays removed: ["banner"]`, and the driven click subsequently
landed on the real target underneath. The sweep's shape — `position: fixed|sticky`,
`z-index > 1000`, more than 25% of viewport area, excluding the pointer overlay itself —
is deliberately vendor-agnostic: two runs against the same URL, on the engine this was
ported from, served two different consent libraries (OneTrust, then a second one) on
separate occasions. A hardcoded selector list would have been a coin flip both times.
REMOVE, never ACCEPT — clicking "allow all" on someone's behalf is consent this tool has
no standing to give, and it would be recorded as if the user had agreed. Re-run after
every scroll: an overlay a later step triggers, or one that reappears, must not survive
into the next beat.

## Scroll first, measure second [derived from the ported engine's own history]

The bounding box a beat clicks moves while the page scrolls to bring it into view, so a
rect taken BEFORE the scroll points at empty space by the time the click lands. This cost
two runs to find in the engine `record.mjs` was ported from. `beat()`/`fill()` always
call `window.__brp.centre(sel)` and wait for it to settle before calling
`el.boundingBox()` — never reorder this.

## Every click is guarded, and the guard has already caught a real defect [derived]

`document.elementFromPoint(x, y)` must resolve to the click target or an ancestor/
descendant of it, or `record.mjs` throws naming whatever WAS on top. Without this guard a
coordinate click can silently hit a leftover overlay while `locator.click()` would still
report success — the take would show a click that visibly did nothing, with no error
anywhere. In the engine this was ported from, the guard caught exactly this class of bug
once already: a Swagger `opblock`'s clickable header is the `.opblock-summary-control`,
not the whole `opblock` box, whose centre falls below the header once it expands.

## Pointer colour is `--sea`, not `--terra` — and it renders correctly [measured]

Verified visually on the smoke-test recording: the drawn pointer is a filled teal circle
(`#5fbfae`, `--sea` from `landing/src/styles/global.css`) with a dark ring (`--bg`,
`#17121d`). `--terra` (`#e87a52`) is deliberately never used — it is close enough to
Claude's own terracotta that a viewer reads the pointer as Claude's rather than as this
product's.

## Fluidity costs bitrate — a trade, not a regression [measured, from the ported engine]

Measured on the same flow: 199 frames / 226,017 bytes with jump-cut scrolling versus 609
frames / 1,509,635 bytes with eased scrolling. `record.mjs`'s `scrollToY`/`centre` drive
the scroll per `requestAnimationFrame` step rather than `scrollIntoView({behavior:
"smooth"})` (whose duration is browser-chosen and untunable) specifically because a
screencast records exactly what the page paints — a jump-cut scroll is a jump-cut in the
deliverable. State the size difference as the cost of legibility, not as something to
optimise away.

## ffmpeg's concat demuxer drops the last frame's duration [measured]

Reproduced twice while building `assets/build-video.sh`: on a 5-frame synthetic take, the
sum of `stamps.json` deltas was 1.4s but the encoded file's `ffprobe`-reported duration
came back 1.867s; on the 117-frame smoke-test take, the span from `record.mjs` was 2.89s
against an encoded duration of 2.967s. Both times the file was still fully correct —
every frame present, in order, at the right relative pacing — just longer by roughly the
final frame's own duration. This is ffmpeg's documented concat-demuxer behaviour: a
`duration` line applies to the file ABOVE it, so the very last file's duration is
otherwise silently dropped unless that file is listed a second time with no duration
after it. `assets/build-video.sh`'s generator already does this (see its
`gen-concat.mjs` heredoc) — the small overshoot is the accepted cost of the last frame
actually appearing at all, not a bug to chase further.

## The output format is H.264 MP4, and a GIF is never shipped [measured, from the ported engine]

A GIF cannot carry a screen recording at quality. 256 colours per frame and no real
interframe prediction means it either bands visibly on gradients and antialiased text or
balloons in size, and it has to drop framerate and resolution just to stay embeddable.
Measured on one 191-frame take of a 1200x800 window:

| output | frames | dimensions | colour | size |
|---|---|---|---|---|
| GIF, 12fps, palettegen `stats_mode=diff` | 92 | 900x526 | 256 | 260K |
| H.264 MP4, 30fps, crf 18 | 191 | 1200x700 | full | 149K |

Better on every axis and 43% smaller. That is why there is no GIF output.

## H.264 over AV1, H.265 and VP9 — measured at matched quality [measured, from the ported engine]

Quality matched with ffmpeg's `libvmaf` against a lossless FFV1 reference built from the
same frames, so these are sizes at equal quality rather than sizes at equal CRF:

| codec | static take (VMAF ~97) | motion take (VMAF ~90) |
|---|---|---|
| H.264 | 149,067 B | 206,889 B |
| H.265 | 150,000 B | 179,425 B |
| AV1 (SVT, `scm=1`) | 286,450 B | 290,857 B |
| VP9 | 283,369 B | 270,715 B |

AV1 and VP9 lose on both, by roughly 2x, which inverts the usual expectation. These takes
are SHORT — seconds, not minutes — so the long-GOP efficiency those codecs are known for
never gets paid back against their container and keyframe overhead. Do not generalise
this to long video; it is a finding about short screen-recording takes.

H.265 wins the motion case by ~13% and is still not used: Chrome and Firefox will not
reliably decode HEVC in MP4, and this file exists to be opened by a reviewer who is not
you. Universal playback beats 13%. This table did not change with the rewrite — the
encode step in `assets/build-video.sh` is the same `libx264 -preset slow -crf 18`
invocation it always was, just fed by a concat file instead of a raw window-cropped
sequence.

## The "live" connection mode's cost is real, and is Chrome's own words [given, not independently re-verified visually]

Confirmed present in Chrome 152 (the version this engine's smoke test ran against, via
`/json/version`): `chrome://inspect/#remote-debugging`'s "Allow remote debugging for this
browser instance" toggle. Its own warning, to be shown to the user before this mode is
used, not paraphrased: it "allows external apps to request full control of this browser.
This includes read access to your saved data, cookies and site data, and the ability to
navigate to any URL." This skill never flips that toggle itself — only the user, in their
own already-running Chrome, and it is their choice to turn it back off afterward.

## `$var[x]` is an array subscript in zsh, not string concatenation

`assets/build-video.sh` is `#!/bin/zsh`. Building a shell string the bash way can
silently destroy it:

    F="crop=1:2,fps=12"
    echo "$F[x]"    ->  (empty)
    echo "${F}[x]"  ->  crop=1:2,fps=12[x]

Nothing in the current script triggers this — there is no ffmpeg filtergraph labelling
(`[out]`-style) left now that there is no crop step — but it remains a standing footgun
for anyone editing these zsh assets. Always brace a variable that is followed by `[`.

## Housekeeping

A take's raw frames are tens of megabytes of JPEGs even for a short flow (117 frames at
1280x800 in the smoke test that verified this engine). Delete `frames/` and
`stamps.json` once `build-video.sh` has produced the final MP4. There is no `clean/`
directory any more — that existed only for the old engine's foreign-window filtering
step, which has no equivalent here: a page screencast cannot contain a frame of another
window, so there is nothing to filter.

## The light path's GIF recorder is a slideshow, by design [measured, carried over]

Carried from `branch-demo`, which this skill absorbed. `gif_creator` captures one frame
per `computer` action — discrete screenshots. It cannot show motion at all, which is why
the Decision Gates send anything with a scroll, a transition or a drag to `record.mjs`
instead.

It also caps at **50 frames, silently**: a take that reaches the cap stops capturing
while your calls keep succeeding, so the tail looks fine in the tool results and is
simply missing from the file. Check the last frame before believing the ending shipped:

    magick out.gif'[N]' last.png

`form_input` does NOT create a frame; `computer` actions do. That is useful rather than
annoying — fill fields with `form_input` and spend the frame budget only on the states
worth showing.

Turn the orange overlays off: `showClickIndicators`, `showProgressBar`, `showWatermark`,
`showActionLabels`. They read as decoration on a document meant for reviewers, and the
full path draws its own pointer in the product's own `--sea` instead.

