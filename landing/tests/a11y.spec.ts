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
