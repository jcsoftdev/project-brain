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
  await expect(page.locator("h1")).toContainText("Your AI stops");
});

test("social and canonical metadata is complete", async ({ page }) => {
  await page.goto("/");

  const meta = (sel: string) => page.locator(sel).getAttribute("content");

  expect(await meta('meta[name="description"]')).toBeTruthy();
  expect(await meta('meta[property="og:title"]')).toContain("project-brain");
  expect(await meta('meta[property="og:description"]')).toBeTruthy();
  // PNG since the SEO pass — SVG share images render blank on every major platform.
  expect(await meta('meta[property="og:image"]')).toContain("og.png");
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

test.describe("SEO surface", () => {
  /*
   * Every one of these was missing at some point during the redesign, and one
   * — the JSON-LD — was silently dropped by a rewrite and nobody noticed until
   * an audit. Metadata has no visual output, so it only stays correct if
   * something asserts it.
   */
  test("the share image is a PNG, and declares its size", async ({ page }) => {
    await page.goto("/");

    const og = await page.locator('meta[property="og:image"]').getAttribute("content");
    /*
     * PNG, not SVG. Facebook, LinkedIn and X do not rasterise SVG for link
     * previews — they render nothing, so a shared link came out blank. This
     * caught exactly that.
     */
    expect(og, "og:image must be a raster format").toMatch(/\.png$/);

    expect(await page.locator('meta[property="og:image:width"]').getAttribute("content")).toBe("1200");
    expect(await page.locator('meta[property="og:image:height"]').getAttribute("content")).toBe("630");
    expect(await page.locator('meta[property="og:image:type"]').getAttribute("content")).toBe("image/png");
    expect(await page.locator('meta[property="og:image:alt"]').getAttribute("content")).toBeTruthy();

    // Twitter reads its own tags before falling back to og:*.
    expect(await page.locator('meta[name="twitter:image"]').getAttribute("content")).toBe(og);
  });

  test("the share image actually exists and is the size it claims", async ({ request, page }) => {
    await page.goto("/");
    const og = (await page.locator('meta[property="og:image"]').getAttribute("content"))!;

    const res = await request.get(new URL(og).pathname);
    expect(res.status(), "og:image 404s — the preview would be blank").toBe(200);
    expect(res.headers()["content-type"]).toContain("png");

    // PNG dimensions live in the IHDR chunk: bytes 16-23 of the file.
    const buf = await res.body();
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  });

  test("robots and sitemap agree, and the sitemap resolves", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);

    const body = await robots.text();
    const line = body.split("\n").find((l) => l.toLowerCase().startsWith("sitemap:"));
    expect(line, "robots.txt advertises no sitemap").toBeTruthy();

    /*
     * The previous robots.txt pointed at /sitemap.xml, which did not exist —
     * every crawler that followed it got a 404. Advertising a sitemap is only
     * useful if the sitemap is there.
     */
    const url = new URL(line!.split(/:\s*/).slice(1).join(":").trim());
    const sitemap = await request.get(url.pathname);
    expect(sitemap.status(), `${url.pathname} is advertised but returns ${sitemap.status()}`).toBe(200);

    const xml = await sitemap.text();
    expect(xml).toContain("brain.jcsoftdev.com");
    expect(xml, "the 404 page must not be listed for indexing").not.toContain("/404");
  });

  test("the page declares itself indexable, structured and canonical", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /brain\.jcsoftdev\.com/);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toContain("index");

    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(ld["@type"]).toBe("SoftwareApplication");
    expect(ld.codeRepository).toContain("github.com/jcsoftdev/project-brain");
    expect(ld.image).toMatch(/\.png$/);
  });

  test("above-the-fold fonts are preloaded", async ({ page }) => {
    await page.goto("/");

    /*
     * Both are used above the fold — the display face in the headline, the
     * mono in the terminal. Without a preload they are discovered only once
     * the CSS parses, which is a visible swap on the largest text on the page.
     */
    const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll((els) =>
      els.map((el) => (el as HTMLLinkElement).getAttribute("href")),
    );
    expect(preloads).toContain("/fonts/outfit.woff2");
    expect(preloads).toContain("/fonts/jetbrains-mono.woff2");

    for (const href of preloads) {
      expect(
        await page.locator(`link[href="${href}"]`).getAttribute("crossorigin"),
        `${href} preloaded without crossorigin — the browser fetches it twice`,
      ).not.toBeNull();
    }
  });
});

test.describe("the hero terminal shows real output", () => {
  /*
   * This section previously carried an invented session: a box-drawing call
   * tree and a "7 symbols affected · depth 3 · 4ms" footer that the CLI does
   * not print in any form. It was a mockup posing as evidence, on a page whose
   * argument is that this tool tells you the truth about your code.
   *
   * These assertions pin it to the shape the CLI actually emits. They cannot
   * prove the paths still exist — that needs the repository — but they fail
   * the moment someone reaches for decoration again.
   */
  test("every output line matches the CLI's real format", async ({ page }) => {
    await page.goto("/");

    const out = await page.locator(".term .out").allTextContents();
    expect(out.length, "the terminal shows no output at all").toBeGreaterThan(0);

    for (const line of out) {
      /*
       * `path:line  kind name — signature`, which is what the CLI prints.
       * Anything else is either invented or the CLI changed and this needs
       * recapturing.
       */
      expect(line, `not CLI output format: ${line}`).toMatch(
        /^src\/[\w./-]+\.ts:\d+\s{2}(class|function|method|const)\s+\w+\s+—\s+.+/,
      );
    }
  });

  test("no invented summary line survived", async ({ page }) => {
    await page.goto("/");
    const body = (await page.locator(".term").textContent())!;

    // The CLI prints no footer, no timing, and no box-drawing tree.
    expect(body, "a fabricated summary line is back").not.toMatch(/symbols affected/);
    expect(body, "a fabricated timing is back").not.toMatch(/\d+ms/);
    expect(body, "box-drawing implies a tree the CLI never prints").not.toMatch(/[├└│─]/);
  });

  test("the commands shown are real subcommands", async ({ page }) => {
    await page.goto("/");

    const cmds = await page.locator(".term .cm").allTextContents();
    expect(cmds.length).toBeGreaterThan(0);

    // Kept in sync with src/constants.ts TOOL_CATALOG's CLI surface.
    const known = ["find", "callers", "callees", "impact", "trace", "map", "code",
                   "search", "sync", "reindex", "health", "init", "setup", "serve", "okf", "update"];
    for (const cmd of cmds) {
      const sub = cmd.replace(/^project-brain\s+/, "").split(/\s+/)[0];
      expect(known, `"${sub}" is not a project-brain subcommand`).toContain(sub);
    }
  });

  test("nothing in the terminal is clipped at any width", async ({ page }) => {
    /*
     * The 78-character width of the captured output is why these two commands
     * were chosen. If someone recaptures with a wider command this fails, which
     * is the point — the window must never hide half of its own evidence.
     */
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const clipped = await page.locator(".term-body").evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );
      expect(clipped, `terminal output is cut off at ${width}px`).toBe(false);
    }
  });
});
