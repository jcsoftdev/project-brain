import { test, expect, type Page } from "@playwright/test";

/*
 * These tests exist because "it looks fine on my screen" is not a claim anyone
 * can check later. Each one pins a specific promise the mobile-first rebuild
 * made, so a future CSS change that breaks it fails here instead of on a phone.
 */

/** Widths spanning every side of the 600 / 880 / 1100 breakpoints. */
const WIDTHS = [320, 375, 414, 599, 600, 768, 879, 880, 1100, 1440];

/**
 * Containers that are *allowed* to scroll sideways, because they were built to.
 * Anything else exceeding the viewport is a layout bug.
 */
const INTENTIONAL_SCROLLERS = [".hosts ul"];

async function overflowingElements(page: Page) {
  return page.evaluate((allowed) => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];

    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right <= vw + 1 && r.left >= -1) return;
      if (allowed.some((sel) => el.closest(sel))) return;
      // Decorative blur, deliberately oversized inside an overflow:hidden parent.
      if (el.classList.contains("hero-glow")) return;

      const cls = typeof el.className === "string" ? el.className : "";
      out.push(`${el.tagName.toLowerCase()}${cls ? "." + cls.trim().split(/\s+/).join(".") : ""}`);
    });

    return out;
  }, INTENTIONAL_SCROLLERS);
}

test.describe("no horizontal overflow", () => {
  for (const width of WIDTHS) {
    test(`page does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(
        scrollWidth,
        `document scrolls horizontally at ${width}px — something is wider than the viewport`,
      ).toBeLessThanOrEqual(clientWidth + 1);

      expect(await overflowingElements(page), `elements overflow the viewport at ${width}px`).toEqual([]);
    });
  }
});

test.describe("tables adapt rather than truncate", () => {
  for (const width of [320, 375, 600, 768, 880, 1024, 1440]) {
    test(`no table clips its content at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");

      /*
       * A table that overflows its own scroll container has content sitting
       * off-screen behind a swipe nobody is told about. The stacking
       * breakpoint per column count exists precisely to prevent this.
       */
      const clipped = await page.locator(".dt").evaluateAll((els) =>
        els
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => `${el.className} (${el.scrollWidth}px in ${el.clientWidth}px)`),
      );

      expect(clipped, `content is cut off at ${width}px`).toEqual([]);
    });
  }

  test("below 600px every table stacks and none scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");

    const tables = page.locator(".dt");
    await expect(tables).not.toHaveCount(0);

    // A stacked table renders as blocks, not a table box.
    const displays = await tables.locator("table").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).display),
    );
    expect(new Set(displays), "tables should be display:block on a phone").toEqual(new Set(["block"]));

    // The whole point: no cut-off sentences hiding behind a sideways swipe.
    const clipped = await tables.evaluateAll((els) =>
      els.filter((el) => el.scrollWidth > el.clientWidth + 1).length,
    );
    expect(clipped, "a table still scrolls sideways on a phone — content is being cut off").toBe(0);
  });

  /*
   * Wider tables need more room before they can be tables again: the columns
   * hold commands that must not wrap, so the threshold scales with count.
   */
  const THRESHOLD = { 2: 600, 3: 820, 4: 1100 } as const;

  for (const [cols, bp] of Object.entries(THRESHOLD)) {
    test(`${cols}-column tables stack below ${bp}px and lay out above it`, async ({ page }) => {
      const selector = `.dt-cols-${cols} table`;

      await page.setViewportSize({ width: bp - 1, height: 900 });
      await page.goto("/");
      const below = await page.locator(selector).evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).display),
      );
      expect(new Set(below), `should still be stacked at ${bp - 1}px`).toEqual(new Set(["block"]));

      await page.setViewportSize({ width: bp, height: 900 });
      const above = await page.locator(selector).evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).display),
      );
      expect(new Set(above), `should be a table at ${bp}px`).toEqual(new Set(["table"]));

      // thead is visually hidden while stacked, not removed — it comes back here.
      await expect(page.locator(`.dt-cols-${cols} thead`).first()).toBeVisible();
    });
  }

  test("stacked cells carry their column name, except where it would be noise", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");

    // Three- and four-column tables need labels to tell CLI from Platforms.
    const labelled = page.locator(".dt.dt-labelled").first();
    await expect(labelled).toBeVisible();
    const label = await labelled.locator("td + td").first().evaluate(
      (el) => getComputedStyle(el, "::before").content,
    );
    expect(label, "labelled tables must stamp the column name above the value").not.toBe("none");

    // Two-column tables suppress it — repeating "WHAT IT DOES" six times is noise.
    const plain = page.locator(".dt:not(.dt-labelled)").first();
    await expect(plain).toBeVisible();
    const noLabel = await plain.locator("td + td").first().evaluate(
      (el) => getComputedStyle(el, "::before").content,
    );
    expect(noLabel, "a two-column table should not repeat a self-evident column name").toBe("none");
  });
});

test.describe("section navigation is always reachable", () => {
  test("phones get a disclosure holding every section at full length", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");

    await expect(page.locator(".nav-links")).toBeHidden();

    const toggle = page.locator("[data-nav-toggle]");
    const menu = page.locator("[data-nav-menu]");

    await expect(toggle).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    const links = menu.locator("a");
    await expect(links).toHaveCount(5);

    // Full labels, no truncation, and each one big enough for a thumb.
    for (const link of await links.all()) {
      const box = await link.boundingBox();
      expect(box, "a menu link has no box").not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);

      const clipped = await link.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped, `"${await link.textContent()}" is being cut off`).toBe(false);
    }
  });

  test("the disclosure closes the ways a reader expects", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");

    const toggle = page.locator("[data-nav-toggle]");
    const menu = page.locator("[data-nav-menu]");

    // 1. Escape closes it and hands focus back to the button that opened it.
    await toggle.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    // 2. Choosing a destination dismisses the panel covering it.
    await toggle.click();
    await menu.locator('a[href="#start"]').click();
    await expect(menu).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // 3. Clicking away means the reader moved on.
    await toggle.click();
    await expect(menu).toBeVisible();
    await page.locator("h1").click();
    await expect(menu).toBeHidden();
  });

  test("crossing the breakpoint while open leaves the markup honest", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");

    const toggle = page.locator("[data-nav-toggle]");
    await toggle.click();
    await expect(page.locator("[data-nav-menu]")).toBeVisible();

    // Widening past 880px must not leave aria-expanded="true" on a button that
    // is no longer rendered.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-nav-menu]")).toBeHidden();
  });

  test("from 880px the links sit inline and the disclosure is gone", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/");

    await expect(page.locator(".nav-links")).toBeVisible();
    await expect(page.locator("[data-nav-toggle]")).toBeHidden();
    await expect(page.locator("[data-nav-menu]")).toBeHidden();
  });

  test("every in-page anchor points at a section that exists", async ({ page }) => {
    await page.goto("/");

    const hrefs = await page.locator('a[href^="#"]').evaluateAll((els) =>
      els.map((el) => (el as HTMLAnchorElement).getAttribute("href")!),
    );
    expect(hrefs.length).toBeGreaterThan(0);

    for (const href of new Set(hrefs)) {
      await expect(page.locator(href), `dead anchor: ${href}`).toHaveCount(1);
    }
  });

  test("the sticky nav does not cover the heading it scrolls to", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    await page.locator("[data-nav-toggle]").click();
    await page.locator('[data-nav-menu] a[href="#tools"]').click();
    await page.waitForTimeout(700); // smooth scroll settles

    const navBottom = (await page.locator("header.nav").boundingBox())!.y +
      (await page.locator("header.nav").boundingBox())!.height;
    const headingTop = (await page.locator("#tools .section-title").boundingBox())!.y;

    expect(headingTop, "the sticky nav is covering the anchored heading").toBeGreaterThanOrEqual(navBottom - 1);
  });
});

test.describe("hero adapts to the viewport", () => {
  test("stats are 2-up on a phone and 4-up on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");
    const mobileCols = await page.locator(".hero-stats").evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(mobileCols).toBe(2);

    await page.setViewportSize({ width: 1440, height: 900 });
    const desktopCols = await page.locator(".hero-stats").evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(desktopCols).toBe(4);
  });

  test("the headline's forced line break is a desktop-only choice", async ({ page }) => {
    await page.goto("/");
    // A <br> has no box, so visibility assertions can never pass on one —
    // the computed display is what the breakpoint actually toggles.
    const display = () => page.locator("h1 br").first().evaluate((el) => getComputedStyle(el).display);

    await page.setViewportSize({ width: 375, height: 900 });
    expect(await display(), "the hero break should not fire on a phone").toBe("none");

    await page.setViewportSize({ width: 1100, height: 900 });
    expect(await display(), "the hero break should fire on desktop").toBe("inline");
  });
});
