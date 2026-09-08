#!/bin/zsh
# Build the deliverable MP4 from record.mjs's screencast frames + real timestamps.
#
# There is no browser-chrome crop here — that only ever existed because the
# prior engine captured the OS WINDOW with avfoundation, tab strip and all.
# record.mjs captures the PAGE itself over CDP (`Page.startScreencast`), so no
# tab strip, URL bar, or "started debugging" banner is ever in the frames to
# begin with. There is also no crop_y, no device match, no HiDPI math: none of
# it applies to a page-level capture.
#
# WHY A CONCAT FILE INSTEAD OF `-framerate $FPS -i frames/%05d.jpg`:
#
# The screencast is VARIABLE-rate — Page.startScreencast only emits a frame
# when the page actually repaints, so idle time between beats produces NO
# frames. Encoding the raw sequence at a flat input framerate would be wrong
# twice over: it plays back FASTER than real time across any idle gap, and it
# throws away the only record of how long each frame was actually on screen.
# record.mjs writes that record as stamps.json — one CDP
# `Page.screencastFrame` `metadata.timestamp` per frame, in seconds, the first
# one normalised to 0. This script turns consecutive timestamp deltas into a
# per-frame `duration` in an ffmpeg concat file, then re-encodes THAT at a
# constant fps=$FPS, so the shipped file is a normal, seekable,
# constant-frame-rate video whose pacing matches what was actually recorded.
#
# WHY H.264 AND NOT A GIF, AND NOT AV1 EITHER — measured, not assumed.
#
# A GIF cannot carry this. 256 colours per frame and no real interframe
# prediction means a screen recording either bands visibly or balloons, and it
# has to drop framerate and resolution to stay embeddable at all. Measured on
# one 191-frame take: the GIF at 12fps / 900px wide / 256 colours came to 260K,
# while H.264 at 30fps / 1200x700 / full colour and VMAF 97.0 came to 149K.
# Better on every axis AND 43% smaller. So there is no GIF output here.
#
# Against the modern codecs, at MATCHED quality on the same source (VMAF via
# ffmpeg's libvmaf, against a lossless FFV1 reference of the same frames):
#
#   static screen take, VMAF ~97      motion take (synthesised scroll), VMAF ~90
#   h264 crf18   149,067 B            h264 crf18   206,889 B
#   h265 crf20   150,000 B            h265 crf21   179,425 B
#   av1  crf30   286,450 B            av1  crf32   290,857 B
#   vp9  crf24   283,369 B            vp9  crf26   270,715 B
#
# AV1 and VP9 LOSE on both, roughly 2x. These takes are short — seconds, not
# minutes — so the long-GOP efficiency those codecs are famous for never gets
# paid back against their container and keyframe overhead. H.265 wins the
# motion case by ~13%, and is not used here anyway: Chrome and Firefox will not
# reliably decode HEVC in MP4, and this file exists to be opened by a reviewer
# who is not you. Universal playback beats 13%.
#
# Also unchanged from the prior engine, still true: FLUIDITY COSTS BITRATE.
# Measured on the same flow: 199 frames / 226,017 bytes with jump-cut scrolling
# versus 609 frames / 1,509,635 bytes with eased scrolling. That is the trade
# record.mjs's eased rAF scroll makes on purpose, not a regression to fix.
#
# Usage: build-video.sh <framedir> <stamps.json> <out.mp4> [play_fps]
#
# <framedir> and <stamps.json> are record.mjs's own outputs: <outdir>/frames
# and <outdir>/stamps.json. Default play_fps is 30 — real time, matching what
# stamps.json already encodes. Lower it to slow down a fast interaction for
# legibility, or raise it to compress a long take with a lot of dead air
# between beats (the concat file's per-frame durations already own the actual
# pacing either way — this only resamples the constant-rate output).

set -e
DIR=${1:?framedir}; STAMPS=${2:?stamps.json}; OUT=${3:?out.mp4}
FPS=${4:-30}

if [ ! -f "$STAMPS" ]; then
  echo "stamps file not found: $STAMPS" >&2
  exit 1
fi

CONCAT="$DIR/../concat.txt"
GEN="$DIR/../gen-concat.mjs"

# A small node generator, not inline zsh: building a duration-annotated
# ffconcat list needs real JSON parsing and float arithmetic, and node is
# already a hard requirement for assets/record.mjs — see its header. Written
# to a scratch file rather than passed via `node -e` because the ffconcat
# `file '...'` lines need literal single quotes, which is painful to escape
# correctly inside a zsh single-quoted `-e` argument.
cat > "$GEN" <<'JS'
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [, , framedir, stampsPath, concatPath] = process.argv;
const stamps = JSON.parse(readFileSync(stampsPath, "utf8"));
const frames = readdirSync(framedir).filter((f) => f.endsWith(".jpg")).sort();

if (frames.length !== stamps.length) {
  console.error(`frame count ${frames.length} != stamp count ${stamps.length} — is stamps.json from a different take?`);
  process.exit(1);
}
if (frames.length === 0) {
  console.error(`no frames in ${framedir}`);
  process.exit(1);
}

const lines = ["ffconcat version 1.0"];
for (let i = 0; i < frames.length; i++) {
  const abs = resolve(framedir, frames[i]);
  const dur =
    i + 1 < stamps.length ? stamps[i + 1] - stamps[i] :
    i > 0 ? stamps[i] - stamps[i - 1] : 1 / 30;
  // Never a zero/negative duration: a repaint burst can stamp two frames at
  // (near) the same instant, and ffmpeg rejects a non-positive duration line.
  lines.push(`file '${abs}'`);
  lines.push(`duration ${Math.max(dur, 1 / 120).toFixed(6)}`);
}
// ffmpeg's concat demuxer silently ignores the FINAL duration line unless the
// last file is listed once more without one — undocumented, but load-bearing:
// skip this and the last frame never appears in playback at all.
lines.push(`file '${resolve(framedir, frames[frames.length - 1])}'`);
writeFileSync(concatPath, lines.join("\n") + "\n");
console.log(`concat: ${frames.length} frames, span=${(stamps.at(-1) - stamps[0]).toFixed(2)}s`);
JS

node "$GEN" "$DIR" "$STAMPS" "$CONCAT"
rm -f "$GEN"

# scale only DOWN, never up: `scale='min(1440,iw)':-2` on a 1200-wide capture
# upscales, which spends bytes inventing pixels that carry no information.
# crf 18, not 22: measured VMAF 97.0 against a lossless reference of the same
# frames, for 149K on a 191-frame take. Screen content is cheap to encode —
# there is no reason to spend quality here.
ffmpeg -y -loglevel error \
  -f concat -safe 0 -i "$CONCAT" \
  -vf "fps=$FPS,scale='min(1440,iw)':-2:flags=lanczos" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart \
  "$OUT"

rm -f "$CONCAT"

ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 "$OUT"
ls -lh "$OUT"

# Sample across the finished file and LOOK at the result. Scoring frames (as
# the prior engine's filter-frames.py did) is not the same as watching what
# shipped — and there is no foreign-window filtering step any more: a page
# screencast cannot contain a frame of another window, so that whole class of
# defect no longer exists.
echo "sample it:  for t in 3 25 50 75 100; do ffmpeg -y -ss \$t -i $OUT -frames:v 1 -vf scale=460:-2 v_\$t.jpg; done && magick v_*.jpg -append check.jpg"
