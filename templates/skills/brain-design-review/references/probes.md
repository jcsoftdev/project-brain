# Rendered-design probes

Pass each body as the `function` of chrome-devtools `evaluate_script`. They return JSON-serializable values. Scans cap at 500 elements.

## Fonts, colors, headings

```js
() => {
  const els = [...document.querySelectorAll("*")].slice(0, 500);
  const cs = els.map((e) => getComputedStyle(e));
  const count = (xs) => Object.entries(xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  return {
    fonts: count(cs.map((s) => s.fontFamily)),
    colors: count(cs.flatMap((s) => [s.color, s.backgroundColor]).filter((c) => c !== "rgba(0, 0, 0, 0)")).slice(0, 30),
    headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({
      tag: h.tagName,
      text: h.textContent.trim().slice(0, 50),
      size: getComputedStyle(h).fontSize,
      weight: getComputedStyle(h).fontWeight,
      textWrap: getComputedStyle(h).textWrap,
    })),
  };
}
```

Flag more than 3 families, more than 12 non-gray colors, skipped heading levels, non-systematic size jumps.

## Touch targets under 44px

```js
() => [...document.querySelectorAll("a,button,input,select,textarea,[role=button]")]
  .map((e) => ({ e, r: e.getBoundingClientRect() }))
  .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
  .slice(0, 20)
  .map(({ e, r }) => ({ tag: e.tagName, text: (e.textContent || "").trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }))
```

## Spacing values in use

```js
() => {
  const vals = new Map();
  for (const e of [...document.querySelectorAll("*")].slice(0, 500)) {
    const s = getComputedStyle(e);
    for (const p of ["paddingTop", "paddingLeft", "marginTop", "marginBottom", "rowGap", "columnGap"]) {
      const v = s[p];
      if (v && v !== "0px" && v !== "normal") vals.set(v, (vals.get(v) || 0) + 1);
    }
  }
  return [...vals].sort((a, b) => b[1] - a[1]).slice(0, 25);
}
```

Compare against the 4 or 8 scale; list the off-scale values with counts.

## Contrast of text against its background

```js
() => {
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const bg = (e) => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c !== "rgba(0, 0, 0, 0)") return c; } return "rgb(255,255,255)"; };
  return [...document.querySelectorAll("p,span,a,li,label,button,h1,h2,h3,td")]
    .filter((e) => e.childNodes.length && e.textContent.trim())
    .slice(0, 300)
    .map((e) => { const a = lum(rgb(getComputedStyle(e).color)), b = lum(rgb(bg(e))); const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); return { text: e.textContent.trim().slice(0, 30), ratio: +r.toFixed(2), size: getComputedStyle(e).fontSize }; })
    .filter((x) => x.ratio < 4.5)
    .slice(0, 20);
}
```

Background with gradients or images is not resolved; confirm those by eye on the screenshot.

## Other single reads

- Reduced motion honored: `() => matchMedia("(prefers-reduced-motion: reduce)").matches` after `emulate` with the media feature.
- Horizontal scroll: `() => document.documentElement.scrollWidth > innerWidth`.
- Viewport meta: `() => document.querySelector('meta[name=viewport]')?.content`.
- Navigation timing: `() => JSON.stringify(performance.getEntriesByType("navigation")[0])`; stringify in the page, entry fields are getters.
- Page errors: read `list_console_messages` after load, not a hand-installed hook.
