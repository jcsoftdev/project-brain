/**
 * T7 — `okf audit` coverage gaps must exclude test files AND fakes/mocks.
 *
 * `looksLikeTest` is the ONE predicate coverage-gap ranking uses to decide
 * that; testing it directly (rather than only through `auditBundle`) pins
 * every path shape the spec names without needing a graph fixture per case.
 */
import { describe, it, expect } from "bun:test";
import { looksLikeTest } from "../../src/okf/audit.js";

describe("looksLikeTest", () => {
  it.each([
    "tests/foo.ts",
    "test/foo.ts",
    "src/__tests__/foo.ts",
    "__mocks__/foo.ts",
    "src/__mocks__/foo.ts",
    "fixtures/foo.ts",
    "src/fixtures/foo.ts",
    "src/foo.test.ts",
    "src/foo.spec.ts",
    "src/foo.fake.ts",
    "src/foo.mock.ts",
    "pkg/thing_test.go",
  ])("treats %s as a test/fake path", (path) => {
    expect(looksLikeTest(path)).toBe(true);
  });

  it.each([
    "src/latest/release.ts",
    "src/testable.ts",
    "src/contest/rules.ts",
    "src/mockingbird.ts",
    "src/fixturestore.ts",
  ])("does not mistake %s (merely containing the substring) for a test/fake path", (path) => {
    expect(looksLikeTest(path)).toBe(false);
  });
});
