import { test, expect } from "@playwright/test";

/*
 * The page is served from a container with a strict, self-contained brief: no
 * third-party requests, no console noise, and a health endpoint the orchestrator
 * can poll. These tests fail if a future change quietly reaches off-host.
 */

test("the page makes no third-party requests", async ({ page }) => {
  const external: string[] = [];

  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      external.push(req.url());
    }
  });

  await page.goto("/", { waitUntil: "networkidle" });

  expect(external, "the landing page must be fully self-contained").toEqual([]);
});

test("nothing errors in the console", async ({ page }) => {
  const problems: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));

  await page.goto("/", { waitUntil: "networkidle" });

  expect(problems).toEqual([]);
});

test("every asset the page references resolves", async ({ page }) => {
  const failed: string[] = [];

  page.on("response", (res) => {
    if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
  });

  await page.goto("/", { waitUntil: "networkidle" });

  expect(failed, "broken asset references").toEqual([]);
});

test("the favicon and OG image are actually served", async ({ request }) => {
  for (const path of ["/favicon.svg", "/og.svg", "/robots.txt"]) {
    const res = await request.get(path);
    expect(res.status(), `${path} is missing`).toBe(200);
  }
});
