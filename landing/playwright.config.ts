import { defineConfig, devices } from "@playwright/test";

/*
 * The suite exercises the built site, not the dev server: the mobile-first
 * claims are about the CSS Astro actually emits, and dev-mode style injection
 * is not that. `webServer` builds and serves dist before the first test.
 */
const PORT = 4331;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },

  /*
   * Three projects, one per layout the CSS actually branches on. The
   * breakpoints are 600 / 880 / 1100, so a phone, a tablet between the first
   * two, and a desktop past the last cover every branch.
   */
  projects: [
    /*
     * Pixel 5 rather than an iPhone profile: the iPhone devices default to
     * WebKit, and pulling a second browser engine down to assert CSS
     * breakpoints buys nothing. Everything here is layout, not engine quirks.
     */
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],

  webServer: {
    command: `bun run build && bunx serve dist -l ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
