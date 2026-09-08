#!/usr/bin/env node
/**
 * brain-record's recording engine: capture a driven browser flow by CDP
 * screencast, not by screen capture.
 *
 * WHY SCREENCAST, NOT SCREEN CAPTURE — verified live, not reasoned. The prior
 * engine drove the browser through the Chrome MCP and captured the SCREEN with
 * `ffmpeg -f avfoundation`. That cannot work: the MCP drives a tab that is not
 * frontmost, so the page reports `visibilityState: "hidden"`, `hasFocus: false`,
 * and therefore `outerWidth: 0, outerHeight: 0, screenX: 0, screenY: 0` — a
 * "read the window rect from the page" instruction returns zeros. Worse, screen
 * capture records the FOREGROUND, which is a different tab entirely; capturing
 * one frame of each attached display confirmed the automated page was on
 * neither. Screen capture and a background-tab driver are structurally
 * incompatible. `Page.startScreencast` captures the PAGE over CDP, so
 * foreground and tab visibility stop mattering.
 *
 * node, never bun [measured]. `chromium.connectOverCDP` from Bun hangs at the
 * websocket upgrade and dies at the 30s timeout, while a plain HTTP GET to
 * `/json/version` succeeds instantly from the same process. The identical
 * script under node connects immediately. Always invoke this file with `node`
 * — see SKILL.md for how playwright-core is resolved without becoming a
 * project-brain dependency.
 *
 * Usage: node record.mjs <outdir> <flow.json> [cdpUrl]
 *   <outdir>     directory to write frames/NNNNN.jpg + stamps.json into
 *   <flow.json>  { startUrl, viewport?, pageUrlIncludes?, beats: [...] } — see
 *                the beat shapes below. Not hardcoded to any one app: every
 *                selector, url and value the flow needs comes from this file,
 *                written by SKILL.md's phase 1 (derive beats).
 *   [cdpUrl]     defaults to http://127.0.0.1:9222
 *
 * Beat shapes (each beat prints a `beat: ...` line to stdout as it completes):
 *   { "action": "click",  "label", "selector", "settleMs"? }
 *     Scroll the target to centre, THEN measure its box (see "scroll first,
 *     measure second" below), verify the click guard, move the drawn pointer,
 *     flash the ripple, and click.
 *   { "action": "fill",   "label", "selector", "value", "settleMs"? }
 *     Same centring, then `<select>.selectOption` falling back to `.fill`.
 *   { "action": "centre", "label"?, "selector", "ms"? }
 *     Scroll only, no click — e.g. bringing a response panel into frame once
 *     the flow's proof has rendered.
 *   { "action": "wait",   "ms" }
 *     A plain pause, e.g. letting an async response arrive before the next beat.
 */
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUT = process.argv[2];
const FLOW_PATH = process.argv[3];
const CDP = process.argv[4] ?? "http://127.0.0.1:9222";

if (!OUT || !FLOW_PATH) {
  console.error("usage: node record.mjs <outdir> <flow.json> [cdpUrl]");
  process.exit(1);
}

const flow = JSON.parse(await readFile(FLOW_PATH, "utf8"));
const { startUrl, viewport = { width: 1280, height: 800 }, pageUrlIncludes, beats = [] } = flow;
if (!startUrl) {
  console.error(`${FLOW_PATH}: "startUrl" is required`);
  process.exit(1);
}

const POINTER = `(() => {
  if (window.__brp) return;
  // project-brain palette (landing/src/styles/global.css). --sea, the
  // STRUCTURAL accent, not --terra: terra is #e87a52, near enough to Claude's
  // own terracotta that a viewer reads the pointer as Claude's rather than as
  // this product's. The ring is --bg (near-black) instead of --fg, because most
  // app UIs under recording are light and a white ring vanishes on them.
  const SEA = '#5fbfae';
  const SEA_LO = 'rgba(95, 191, 174, 0.16)';
  const INK = '#17121d';
  const dot = document.createElement('div');
  dot.id = '__brain-record-pointer';
  Object.assign(dot.style, {
    position:'fixed', width:'18px', height:'18px', borderRadius:'50%',
    background:SEA, border:'2px solid ' + INK,
    boxShadow:'0 0 0 2px rgba(243,236,230,0.85), 0 2px 10px rgba(23,18,29,0.5)',
    pointerEvents:'none', zIndex:2147483647,
    left:'0px', top:'0px', marginLeft:'-9px', marginTop:'-9px',
  });
  document.documentElement.appendChild(dot);
  const kf = document.createElement('style');
  kf.textContent = '@keyframes brPing{from{transform:scale(1);opacity:1}to{transform:scale(2.8);opacity:0}}';
  document.head.appendChild(kf);

  const ease = t => t * t * (3 - 2 * t);
  const frame = () => new Promise(r => requestAnimationFrame(r));

  window.__brp = {
    async moveTo(x, y, ms = 320) {
      const x0 = parseFloat(dot.style.left) || 0, y0 = parseFloat(dot.style.top) || 0;
      const t0 = performance.now();
      for (;;) {
        const t = Math.min((performance.now() - t0) / ms, 1), e = ease(t);
        dot.style.left = (x0 + (x - x0) * e) + 'px';
        dot.style.top  = (y0 + (y - y0) * e) + 'px';
        if (t >= 1) break;
        await frame();
      }
    },
    // Eased, frame-by-frame scroll. scrollIntoView({behavior:'smooth'}) is not
    // used: its duration is browser-chosen and untunable, and a screencast
    // records exactly what the page paints, so a jump-cut scroll is a jump-cut
    // in the deliverable. Driving it per rAF keeps the pointer glued to its
    // target while the page moves under it.
    async scrollToY(targetY, ms = 700) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const to = Math.max(0, Math.min(targetY, max));
      const from = window.scrollY;
      if (Math.abs(to - from) < 2) return;
      const t0 = performance.now();
      for (;;) {
        const t = Math.min((performance.now() - t0) / ms, 1);
        window.scrollTo(0, from + (to - from) * ease(t));
        if (t >= 1) break;
        await frame();
      }
    },
    async centre(sel, ms = 700) {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      await this.scrollToY(window.scrollY + r.top - (window.innerHeight - r.height) / 2, ms);
    },
    click() {
      const r = document.createElement('div');
      Object.assign(r.style, {
        position:'fixed', left:dot.style.left, top:dot.style.top,
        width:'18px', height:'18px', marginLeft:'-9px', marginTop:'-9px',
        borderRadius:'50%', border:'2px solid ' + SEA, background:SEA_LO,
        pointerEvents:'none', zIndex:2147483647, animation:'brPing 560ms ease-out',
      });
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 560);
    },
  };
})()`;

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = pageUrlIncludes
  ? (ctx.pages().find((p) => p.url().includes(pageUrlIncludes)) ?? ctx.pages()[0])
  : ctx.pages()[0];
await page.setViewportSize(viewport).catch(() => {});
await page.goto(startUrl, { waitUntil: "networkidle" });

await mkdir(`${OUT}/frames`, { recursive: true });
const session = await ctx.newCDPSession(page);

let n = 0;
const stamps = [];
session.on("Page.screencastFrame", async (f) => {
  const i = ++n;
  stamps.push(f.metadata.timestamp);
  await writeFile(`${OUT}/frames/${String(i).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64"));
  await session.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});

await page.addInitScript(POINTER);
await page.evaluate(POINTER);

// Consent overlays are removed GENERICALLY, never by vendor selector. Two runs
// against the SAME url served two different consent libraries (OneTrust, then
// ch2), so a hardcoded list is a coin flip. What they share is the shape: a
// fixed/sticky element with a large z-index covering most of the viewport,
// which swallows coordinate clicks while locator.click() would still report
// success.
//
// REMOVED, never ACCEPTED. Clicking "allow all" on someone's behalf is consent
// this script has no standing to give, and it would also be recorded as if the
// user had agreed. Re-run after every scroll — an overlay that reappears (or a
// new one a later step triggers) must not survive into the next beat.
const clearOverlays = async () => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, killed = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const z = parseInt(cs.zIndex, 10);
    if (!(z > 1000)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < vw * vh * 0.25) continue;
    if (el.id === '__brain-record-pointer' || el.contains(document.querySelector('#__brain-record-pointer'))) continue;
    killed.push((el.id || el.className || el.tagName).toString().slice(0, 40));
    el.remove();
  }
  return killed;
});
console.log("overlays removed:", JSON.stringify(await clearOverlays()));

await session.send("Page.startScreencast", {
  format: "jpeg", quality: 90, everyNthFrame: 1, maxWidth: viewport.width, maxHeight: viewport.height,
});

const beat = async (label, sel, settleMs = 900) => {
  // Scroll first and eased, THEN measure. The box moves while the page scrolls,
  // so a rect taken before the scroll points at empty space when the click
  // lands. This broke two runs of the flow this engine was ported from.
  await page.evaluate(([s]) => window.__brp.centre(s), [sel]);
  await page.waitForTimeout(220);
  const el = page.locator(sel).first();
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${label} (${sel})`);
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  await clearOverlays();
  // Every click is guarded by elementFromPoint resolving to the target or an
  // ancestor/descendant of it. Without this a coordinate click can silently
  // hit a curtain (a leftover overlay, a tooltip, anything) while
  // `locator.click()` would still report success.
  const onTop = await page.evaluate(([x, y, sel]) => {
    const e = document.elementFromPoint(x, y);
    const want = document.querySelector(sel);
    return { cls: e ? (e.className || e.tagName) + '' : 'none',
             ok: !!(e && want && (want === e || want.contains(e) || e.contains(want))) };
  }, [x, y, sel]);
  if (!onTop.ok) throw new Error(`${label}: "${onTop.cls}" is on top at ${x},${y} — a click here would hit that, not the target`);
  await page.evaluate(([x, y]) => window.__brp.moveTo(x, y), [x, y]);
  await page.evaluate(() => window.__brp.click());
  await page.mouse.click(x, y);
  await page.waitForTimeout(settleMs);
  console.log(`beat: ${label} @ ${x},${y} topmost=${onTop.cls}`);
};

const fill = async (label, sel, value, settleMs = 700) => {
  await page.evaluate(([s]) => window.__brp.centre(s), [sel]);
  await page.waitForTimeout(220);
  await clearOverlays();
  const el = page.locator(sel).first();
  const box = await el.boundingBox();
  if (box) {
    await page.evaluate(([x, y]) => window.__brp.moveTo(x, y),
      [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
  }
  await el.selectOption(value).catch(async () => { await el.fill(value); });
  await page.waitForTimeout(settleMs);
  console.log(`beat: ${label}`);
};

const centre = async (label, sel, ms = 700) => {
  await page.evaluate(([s, ms]) => window.__brp.centre(s, ms), [sel, ms]);
  await page.waitForTimeout(220);
  await clearOverlays();
  console.log(`beat: ${label ?? `centre ${sel}`}`);
};

const wait = async (ms) => {
  await page.waitForTimeout(ms);
};

await page.waitForTimeout(600);

for (const b of beats) {
  switch (b.action) {
    case "click":
      await beat(b.label, b.selector, b.settleMs);
      break;
    case "fill":
      await fill(b.label, b.selector, b.value, b.settleMs);
      break;
    case "centre":
      await centre(b.label, b.selector, b.ms);
      break;
    case "wait":
      await wait(b.ms);
      break;
    default:
      throw new Error(`${FLOW_PATH}: unknown beat action "${b.action}"`);
  }
}

await session.send("Page.stopScreencast");
await browser.close();

// The screencast is VARIABLE-rate: it only emits a frame when the page
// actually repaints, so idle time produces none. stamps.json is what lets
// assets/build-video.sh reconstruct real elapsed time between frames — never
// encode this sequence at a fixed input rate.
const first = stamps[0] ?? 0;
await writeFile(`${OUT}/stamps.json`, JSON.stringify(stamps.map((t) => t - first)));
console.log(`frames=${n} span=${(((stamps.at(-1) ?? first)) - first).toFixed(2)}s`);
