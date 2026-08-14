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
