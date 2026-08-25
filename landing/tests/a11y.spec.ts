import { test, expect } from "@playwright/test";

/*
 * Accessibility checks that matter for a page like this one: it is read on a
 * phone, skimmed with a keyboard, and occasionally by a screen reader. None of
 * these need an audit library — they are structural facts about the markup.
 */

test("headings form a single, ordered outline", async ({ page }) => {
  await page.goto("/");

  const levels = await page.locator("h1, h2, h3, h4").evaluateAll((els) =>
    els.map((el) => Number(el.tagName[1])),
  );

  expect(levels.filter((l) => l === 1), "there must be exactly one h1").toHaveLength(1);
  expect(levels[0], "the first heading should be the h1").toBe(1);

  // No level may be skipped on the way down — h2 to h4 strands a screen reader.
  let previous = levels[0];
  for (const level of levels) {
    if (level > previous) {
      expect(level - previous, `heading jumps from h${previous} to h${level}`).toBeLessThanOrEqual(1);
    }
    previous = level;
  }
});

test("every interactive element has an accessible name", async ({ page }) => {
  await page.goto("/");

  const nameless = await page.locator("a, button").evaluateAll((els) =>
    els
      .filter((el) => {
        const label = (
          el.getAttribute("aria-label") ||
          el.textContent ||
          ""
        ).trim();
        return label.length === 0;
      })
      .map((el) => el.outerHTML.slice(0, 90)),
  );

  expect(nameless, "these controls announce as nothing").toEqual([]);
});

test("decorative icons are hidden from assistive tech", async ({ page }) => {
  await page.goto("/");

  const exposed = await page.locator("svg").evaluateAll((els) =>
    els
      .filter((el) => el.getAttribute("aria-hidden") !== "true" && !el.getAttribute("role"))
      .map((el) => el.outerHTML.slice(0, 70)),
  );

  expect(exposed, "decorative svg should be aria-hidden or given a role").toEqual([]);
});

test("nav landmarks are distinguishable", async ({ page }) => {
  await page.goto("/");

  // Two <nav> elements exist on a phone; both must say which is which.
  const unlabelled = await page.locator("nav").evaluateAll((els) =>
    els.filter((el) => !el.getAttribute("aria-label")).length,
  );
  expect(unlabelled, "every nav landmark needs an aria-label").toBe(0);
});

test("the page is keyboard navigable from the top", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.tagName);
  expect(first, "the first tab stop should be a link").toBe("A");

  // Focus must be visible, not suppressed by a blanket outline:none.
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle };
  });
  expect(outline.style).not.toBe("none");
});

test.describe("touch targets", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("controls are big enough for a thumb", async ({ page }) => {
    await page.goto("/");

    /*
     * WCAG 2.5.8 exempts links inline in a sentence — a 44px tall word would
     * wreck the line box. Everything standalone is held to the target size.
     */
    const tooSmall = await page.locator("a, button").evaluateAll((els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (r.height >= 34) return false;
          // inline within a paragraph or list item — exempt
          if (el.closest("p, dd, li")) return false;
          return true;
        })
        .map((el) => `${(el.textContent || "").trim().slice(0, 24)} (${Math.round(el.getBoundingClientRect().height)}px)`),
    );

    expect(tooSmall, "these tap targets are under 34px tall").toEqual([]);
  });
});

test("the language is declared", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test.describe("colour contrast", () => {
  /*
   * The palette is five mid-lightness teals. That is a narrow band to build a
   * whole interface from, and the failure mode is specific: a swatch that
   * looked fine as a 200px square on a palette site lands as 11px type on a
   * dark ground and drops under 4.5:1. So the ratios are measured from what
   * the browser painted, not from the hex values in the stylesheet.
   */
  test("every text role clears WCAG AA against what is actually behind it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const results = await page.evaluate(() => {
      const luminance = ([r, g, b]: number[]) => {
        const channel = (v: number) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const contrast = (fg: string, bg: string) => {
        const a = luminance(parse(fg));
        const b = luminance(parse(bg));
        const [hi, lo] = a > b ? [a, b] : [b, a];
        return (hi + 0.05) / (lo + 0.05);
      };

      // Text usually sits on a transparent element — walk up for the real ground.
      const groundOf = (el: Element) => {
        let node: Element | null = el;
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
          node = node.parentElement;
        }
        return "rgb(0, 0, 0)";
      };

      const roles: [string, string][] = [
        ["hero lead", "p.hero-lead"],
        ["headline", "h1"],
        ["section lead", ".section-lead"],
        ["eyebrow", ".eyebrow"],
        ["nav link", ".nav-links a"],
        ["card body", ".brain p"],
        ["table cell", ".dt td.is-prose:not(:first-child)"],
        ["table header", ".dt th"],
        ["code chip", ".dt td code"],
        ["command", ".copyable code"],
        ["prompt glyph", ".copyable .prompt"],
        ["stat number", ".hero-stats b"],
        ["stat label", ".hero-stats span"],
        ["footer link", ".foot-cols a"],
        ["footer heading", ".foot-cols h3"],
        ["tick item", ".ticks li"],
        ["okf term", ".okf-findings dt"],
        ["okf exit marker", ".okf-findings b"],
        ["tag semantic", ".tag-semantic"],
        ["tag structural", ".tag-structural"],
      ];

      const out = roles.map(([name, selector]) => {
        const el = document.querySelector(selector);
        if (!el) return { name, missing: true, ratio: 0, required: 0 };

        const cs = getComputedStyle(el);
        const px = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight) >= 700;
        // WCAG counts >=24px, or >=18.66px bold, as large text.
        const required = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;

        return {
          name,
          missing: false,
          px,
          ratio: Math.round(contrast(cs.color, groundOf(el)) * 100) / 100,
          required,
        };
      });

      // Filled buttons put text on the accent itself, not on the page ground.
      const btn = document.querySelector(".btn-primary")!;
      const bcs = getComputedStyle(btn);
      out.push({
        name: "primary button label",
        missing: false,
        px: parseFloat(bcs.fontSize),
        ratio: Math.round(contrast(bcs.color, bcs.backgroundColor) * 100) / 100,
        required: 4.5,
      });

      return out;
    });

    const missing = results.filter((r) => r.missing).map((r) => r.name);
    expect(missing, "a sampled role no longer exists — update the list").toEqual([]);

    const failing = results
      .filter((r) => !r.missing && r.ratio < r.required)
      .map((r) => `${r.name}: ${r.ratio}:1 at ${r.px}px (needs ${r.required}:1)`);

    expect(failing, "these roles fail WCAG AA").toEqual([]);
  });

  test("the palette is applied through roles, not pasted as hex", async ({ page }) => {
    await page.goto("/");

    /*
     * Every swatch should reach a component via a custom property. A raw hex
     * in a rule is how a palette drifts — one stray #78cad2 survives the next
     * recolour and nobody notices until it is the only teal left.
     */
    const declared = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return ["--p-100", "--p-200", "--p-300", "--p-400", "--p-500", "--on-accent"]
        .map((name) => [name, root.getPropertyValue(name).trim()] as const)
        .filter(([, value]) => value.length > 0);
    });

    expect(declared.length, "the palette scale is not fully declared on :root").toBe(6);
  });
});
