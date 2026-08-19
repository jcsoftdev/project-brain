import { describe, it, expect } from "bun:test";
import { isAlwaysIgnored } from "../../src/indexer/always-ignore.js";

/**
 * The always-ignore list names DIRECTORIES. Matching it as a raw substring
 * silently drops real source files whose names merely start with one of those
 * words — found in a live index where `console/config/targets.js` was missing
 * because a rule exists for `target/`.
 */
describe("isAlwaysIgnored", () => {
  it("ignores the directories it names", () => {
    expect(isAlwaysIgnored("node_modules/react/index.js")).toBe(true);
    expect(isAlwaysIgnored("src/dist/bundle.js")).toBe(true);
    expect(isAlwaysIgnored("apps/web/build/main.js")).toBe(true);
    expect(isAlwaysIgnored(".git/config")).toBe(true);
  });

  it("keeps files whose NAME merely begins with an ignored directory name", () => {
    // Each of these was excluded from a real project's index.
    expect(isAlwaysIgnored("console/config/targets.js")).toBe(false);
    expect(isAlwaysIgnored("app/utils/build-roles-index.js")).toBe(false);
    expect(isAlwaysIgnored("builds/osx/spc/libgeos.php")).toBe(false);
    expect(isAlwaysIgnored("src/distribute.ts")).toBe(false);
  });

  it("keeps a directory whose name merely begins with an ignored one", () => {
    expect(isAlwaysIgnored("builds/linux/spc/x.php")).toBe(false);
    expect(isAlwaysIgnored("targets/prod/config.yaml")).toBe(false);
  });

  it("matches an ignored directory at any depth", () => {
    expect(isAlwaysIgnored("a/b/c/node_modules/x.js")).toBe(true);
  });

  it("matches the directory entry itself, not just files under it", () => {
    // listAllFiles tests each entry, including directories, before recursing.
    expect(isAlwaysIgnored("node_modules")).toBe(true);
    expect(isAlwaysIgnored("apps/web/dist")).toBe(true);
  });
});

/**
 * Agent tooling writes timestamped artifacts into the repo and deletes them
 * again on the next run. Indexing them turns an unchanged project into a
 * permanently churning one.
 */
describe("isAlwaysIgnored — generated agent/test artifacts", () => {
  it("ignores tool-generated artifact directories", () => {
    // Measured on a real project: 195 of these in the manifest, driving
    // 163 ingested + 428 deleted on EVERY sync of a repo nobody had edited,
    // at ~4.1 GB of new fragments per run.
    expect(isAlwaysIgnored(".playwright-mcp/page-2026-08-13T20-07-10-424Z.yml")).toBe(true);
    expect(isAlwaysIgnored("apps/web/playwright-report/index.html")).toBe(true);
    expect(isAlwaysIgnored("test-results/retry1/trace.zip")).toBe(true);
  });

  it("keeps source files whose names merely begin with those directory names", () => {
    expect(isAlwaysIgnored("src/test-results-parser.ts")).toBe(false);
    expect(isAlwaysIgnored("scripts/playwright-report-upload.js")).toBe(false);
    expect(isAlwaysIgnored("e2e/playwright.config.ts")).toBe(false);
  });
});
