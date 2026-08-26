import { test, expect } from "@playwright/test";

/*
 * The page makes factual claims about the product and links out to where those
 * claims can be checked. These tests guard the things that quietly rot: a stale
 * version badge, a dead outbound link, a missing OG tag nobody notices until a
 * shared link unfurls as a bare URL.
 */

test("the shell is present and titled", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/project-brain/);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toContainText("Your AI assistant stops");
});

test("social and canonical metadata is complete", async ({ page }) => {
  await page.goto("/");

  const meta = (sel: string) => page.locator(sel).getAttribute("content");

  expect(await meta('meta[name="description"]')).toBeTruthy();
  expect(await meta('meta[property="og:title"]')).toContain("project-brain");
  expect(await meta('meta[property="og:description"]')).toBeTruthy();
  expect(await meta('meta[property="og:image"]')).toContain("og.svg");
  expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /brain\.jcsoftdev\.com/);
});

test("structured data describes the software, not a generic page", async ({ page }) => {
  await page.goto("/");

  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  expect(raw).toBeTruthy();

  const data = JSON.parse(raw!);
  expect(data["@type"]).toBe("SoftwareApplication");
  expect(data.name).toBe("project-brain");
  expect(data.author.name).toBe("jcsoftdev");
  expect(data.license).toContain("MIT");
});

test("the install command is the real one, everywhere it appears", async ({ page }) => {
  await page.goto("/");

  const brew = page.locator('[data-command="brew install jcsoftdev/tap/project-brain"]');
  // Hero, quick-start step 01, and the closing CTA all offer the same command.
  await expect(brew).toHaveCount(3);
});

test("every documented command is offered with a copy button", async ({ page }) => {
  await page.goto("/");

  const blocks = page.locator(".copyable");
  const count = await blocks.count();
  expect(count).toBeGreaterThanOrEqual(6);

  for (const block of await blocks.all()) {
    const command = await block.getAttribute("data-command");
    expect(command, "a copyable block has no command to copy").toBeTruthy();
    // What the button copies must match what the reader sees.
    await expect(block.locator("code")).toContainText(command!);
    await expect(block.locator("button.copy-btn")).toBeVisible();
  }
});

test("outbound links are safe and point somewhere real", async ({ page }) => {
  await page.goto("/");

  const external = page.locator('a[href^="http"]');
  const count = await external.count();
  expect(count).toBeGreaterThan(0);

  for (const link of await external.all()) {
    const href = (await link.getAttribute("href"))!;
    expect(href, `${href} should be https`).toMatch(/^https:\/\//);
    // target="_blank" without noopener hands the opener to the destination.
    const target = await link.getAttribute("target");
    if (target === "_blank") {
      expect(await link.getAttribute("rel"), `${href} needs rel=noopener`).toContain("noopener");
    }
  }
});

test("the repository and package are both linked", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('a[href="https://github.com/jcsoftdev/project-brain"]').first()).toBeVisible();
  await expect(page.locator('a[href="https://www.npmjs.com/package/project-brain"]').first()).toBeVisible();
});

test("the copy button actually writes the command to the clipboard", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-only here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  const block = page.locator(".copyable").first();
  const expected = (await block.getAttribute("data-command"))!;

  await block.locator("button.copy-btn").click();

  await expect(block.locator(".copy-text")).toHaveText("copied");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(expected);

  // The confirmation is temporary, not a stuck state.
  await expect(block.locator(".copy-text")).toHaveText("copy", { timeout: 4000 });
});

test.describe("the page uses one vocabulary for its sections", () => {
  /*
   * Nav and footer both render the section list, and before they shared a
   * module the same anchor was called "Recipes" in one place and "MCP tools"
   * in another. Two names for one destination reads as machine-assembled.
   */
  test("nav and footer agree on what each section is called", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const labelsFor = async (scope: string) =>
      page.locator(`${scope} a[href^="#"]`).evaluateAll((els) =>
        Object.fromEntries(
          els.map((el) => [
            (el as HTMLAnchorElement).getAttribute("href"),
            (el.textContent || "").trim(),
          ]),
        ),
      );

    const nav = await labelsFor(".nav-links");
    const footer = await labelsFor(".foot-cols");

    expect(Object.keys(nav).length).toBe(5);
    for (const [href, label] of Object.entries(nav)) {
      expect(footer[href], `${href} is called "${label}" in the nav but "${footer[href]}" in the footer`).toBe(label);
    }
  });

  test("no section is labelled with leftover README jargon", async ({ page }) => {
    await page.goto("/");

    const labels = await page.locator('a[href^="#"]').evaluateAll((els) =>
      els.map((el) => (el.textContent || "").trim().toLowerCase()),
    );

    // "Recipes" made sense in the README, where the reader already knows the
    // tool. On a landing page it hides what is behind the link.
    expect(labels, "a nav label reverted to README jargon").not.toContain("recipes");
  });

  test("each nav label is echoed by the section it points at", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const entries = await page.locator('.nav-links a[href^="#"]').evaluateAll((els) =>
      els.map((el) => ({
        href: (el as HTMLAnchorElement).getAttribute("href")!,
        label: (el.textContent || "").trim(),
      })),
    );

    for (const { href, label } of entries) {
      const eyebrow = page.locator(`${href} .eyebrow`).first();
      await expect(eyebrow, `${href} has no eyebrow to confirm the nav label`).toHaveCount(1);

      /*
       * Containment, not equality. A section is allowed to be more specific
       * than its menu entry once you are looking at it — "Tools" in the nav
       * opening a section headed "MCP tools" reads as a refinement, not a
       * different destination. What this still catches is the real failure:
       * a section announcing itself with an unrelated word, the way "Recipes"
       * used to sit behind a link the nav called something else.
       */
      expect(
        (await eyebrow.textContent())!.trim().toLowerCase(),
        `nav says "${label}" but ${href} announces itself as something unrelated`,
      ).toContain(label.toLowerCase());
    }
  });
});
