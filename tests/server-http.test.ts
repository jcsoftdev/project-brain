import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * T-12: authorize() pure helper — exhaustive unit tests
 * T-13: createHttpServer() — unit-testable portion (token guard)
 */

describe("authorize (T-12)", () => {
  it("returns true for a valid Bearer token", async () => {
    const { authorize } = await import("../src/server-http.js");
    expect(authorize("Bearer test-secret", "test-secret")).toBe(true);
  });

  it("returns false when header is undefined (missing Authorization)", async () => {
    const { authorize } = await import("../src/server-http.js");
    expect(authorize(undefined, "test-secret")).toBe(false);
  });

  it("returns false when header has no Bearer prefix (Basic scheme)", async () => {
    const { authorize } = await import("../src/server-http.js");
    expect(authorize("Basic dXNlcjpwYXNz", "test-secret")).toBe(false);
  });

  it("returns false for wrong token value of same length", async () => {
    const { authorize } = await import("../src/server-http.js");
    // "wrongsecret" and "test-secret" are both 11 chars — timing attack vector
    expect(authorize("Bearer wrongsecret", "test-secret")).toBe(false);
  });

  it("returns false for wrong token with different length", async () => {
    const { authorize } = await import("../src/server-http.js");
    expect(authorize("Bearer short", "test-secret")).toBe(false);
  });

  it("returns false when expected token is empty (misconfigured server)", async () => {
    const { authorize } = await import("../src/server-http.js");
    expect(authorize("Bearer anything", "")).toBe(false);
  });

  it("Scenario 4.6: token value does not appear in any log output", async () => {
    const { authorize } = await import("../src/server-http.js");

    const loggedMessages: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: unknown[]) => loggedMessages.push(args.join(" "));
    console.warn = (...args: unknown[]) => loggedMessages.push(args.join(" "));
    console.error = (...args: unknown[]) => loggedMessages.push(args.join(" "));

    try {
      authorize("Bearer super-secret", "super-secret");
      authorize(undefined, "super-secret");
      authorize("Bearer wrong", "super-secret");
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const combined = loggedMessages.join("\n");
    expect(combined).not.toContain("super-secret");
  });
});

describe("createHttpServer — token guard (T-13)", () => {
  it("Scenario 4.1: rejects with error when token is empty string", async () => {
    const { createHttpServer } = await import("../src/server-http.js");

    await expect(
      createHttpServer({ port: 13001, token: "" })
    ).rejects.toThrow();
  });

  it("Scenario 4.1: rejects with error when token is whitespace only", async () => {
    const { createHttpServer } = await import("../src/server-http.js");

    await expect(
      createHttpServer({ port: 13002, token: "   " })
    ).rejects.toThrow();
  });

  it("resolves to a handle with port and close() when token is valid", async () => {
    const { createHttpServer } = await import("../src/server-http.js");

    const handle = await createHttpServer({ port: 13003, token: "valid-token" });
    expect(handle).toBeDefined();
    expect(handle.port).toBe(13003);
    expect(typeof handle.close).toBe("function");
    // Close without binding (handle is pre-wired but not listening on port yet)
    await handle.close();
  });
});
