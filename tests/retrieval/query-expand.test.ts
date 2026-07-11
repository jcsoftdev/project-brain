import { describe, it, expect } from "bun:test";
import { expandQuery } from "../../src/retrieval/query-expand.js";

describe("expandQuery — identifier splitting", () => {
  it("splits camelCase and appends the parts, keeping the original", () => {
    const out = expandQuery("getUserName");
    expect(out).toContain("getUserName");
    expect(out).toContain("get");
    expect(out).toContain("user");
    expect(out).toContain("name");
  });

  it("splits snake_case and appends the parts, keeping the original", () => {
    const out = expandQuery("user_id_token");
    expect(out).toContain("user_id_token");
    expect(out).toContain("user");
    expect(out).toContain("id");
    expect(out).toContain("token");
  });

  it("splits kebab-case and appends the parts, keeping the original", () => {
    const out = expandQuery("rate-limit-config");
    expect(out).toContain("rate-limit-config");
    expect(out).toContain("rate");
    expect(out).toContain("limit");
    expect(out).toContain("config");
  });

  it("appends parts for every identifier token in a multi-token query", () => {
    const out = expandQuery("getUserName user_id_token");
    expect(out).toContain("getUserName");
    expect(out).toContain("get");
    expect(out).toContain("user_id_token");
    expect(out).toContain("token");
  });
});

describe("expandQuery — CODE_SYNONYMS", () => {
  it("expands auth to authentication and keeps the original term", () => {
    const out = expandQuery("auth flow");
    expect(out).toContain("auth");
    expect(out).toContain("authentication");
  });

  it("expands authentication back to auth (bidirectional)", () => {
    const out = expandQuery("authentication flow");
    expect(out).toContain("authentication");
    expect(out).toContain("auth");
  });

  it("expands cfg to config and back", () => {
    expect(expandQuery("cfg loader")).toContain("config");
    expect(expandQuery("config loader")).toContain("cfg");
  });

  it("expands btn to button and back", () => {
    expect(expandQuery("btn click")).toContain("button");
    expect(expandQuery("button click")).toContain("btn");
  });

  it("expands throttle to rate limit and back", () => {
    expect(expandQuery("throttle requests")).toContain("rate limit");
    expect(expandQuery("rate limit requests")).toContain("throttle");
  });

  it("expands db to database and back", () => {
    expect(expandQuery("db connection")).toContain("database");
    expect(expandQuery("database connection")).toContain("db");
  });

  it("expands msg to message and back", () => {
    expect(expandQuery("msg queue")).toContain("message");
    expect(expandQuery("message queue")).toContain("msg");
  });

  it("expands err to error and back", () => {
    expect(expandQuery("err handler")).toContain("error");
    expect(expandQuery("error handler")).toContain("err");
  });

  it("expands fn to function and back", () => {
    expect(expandQuery("fn call")).toContain("function");
    expect(expandQuery("function call")).toContain("fn");
  });

  it("expands repo to repository and back", () => {
    expect(expandQuery("repo pattern")).toContain("repository");
    expect(expandQuery("repository pattern")).toContain("repo");
  });

  it("expands dir to directory and back", () => {
    expect(expandQuery("dir listing")).toContain("directory");
    expect(expandQuery("directory listing")).toContain("dir");
  });

  it("expands init to initialize and back", () => {
    expect(expandQuery("init phase")).toContain("initialize");
    expect(expandQuery("initialize phase")).toContain("init");
  });

  it("expands async to asynchronous and back", () => {
    expect(expandQuery("async call")).toContain("asynchronous");
    expect(expandQuery("asynchronous call")).toContain("async");
  });

  it("expands impl to implementation and back", () => {
    expect(expandQuery("impl detail")).toContain("implementation");
    expect(expandQuery("implementation detail")).toContain("impl");
  });
});

describe("expandQuery — safety and idempotence", () => {
  it("always retains the original raw query verbatim somewhere in the output", () => {
    const raw = "getUserName auth";
    expect(expandQuery(raw)).toContain(raw);
  });

  it("does not crash and returns a string on empty input", () => {
    expect(() => expandQuery("")).not.toThrow();
    expect(typeof expandQuery("")).toBe("string");
  });

  it("does not crash on whitespace-only input", () => {
    expect(() => expandQuery("   ")).not.toThrow();
    expect(typeof expandQuery("   ")).toBe("string");
  });

  it("does not crash on punctuation-only input", () => {
    expect(() => expandQuery("!!!???...")).not.toThrow();
    expect(typeof expandQuery("!!!???...")).toBe("string");
  });

  it("leaves plain prose with no code identifiers or synonyms effectively unexpanded", () => {
    const out = expandQuery("the quick brown fox");
    expect(out).toContain("the quick brown fox");
  });
});

describe("expandQuery — realistic end-to-end query", () => {
  it("expands a realistic mixed query with identifiers and abbreviations", () => {
    const out = expandQuery("getUserAuth db-config err_msg");
    // original retained
    expect(out).toContain("getUserAuth db-config err_msg");
    // identifier splitting
    expect(out).toContain("get");
    expect(out).toContain("user");
    expect(out).toContain("auth");
    expect(out).toContain("db");
    expect(out).toContain("config");
    expect(out).toContain("err");
    expect(out).toContain("msg");
    // synonym expansion
    expect(out).toContain("authentication");
    expect(out).toContain("database");
    expect(out).toContain("error");
    expect(out).toContain("message");
  });
});
