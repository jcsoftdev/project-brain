import { describe, it, expect } from "bun:test";
import { findSharedServer, parseEtime, parsePs, serverMode } from "../../src/browser/server-stats.js";
import { assess, DEFAULT_MAX_MB, maxMb } from "../../src/browser/budget.js";
import { browserRouteNotice } from "../../src/hooks/browser-route.js";

const PROFILE = "/d/chrome-profile";
const PS = [
  "18656     1 32384 04-20:33:21 /x/python /x/mcp-proxy --port 39100 --host 127.0.0.1 -- /x/node /x/chrome-devtools-mcp/build/main.js --headless --userDataDir=/d/chrome-profile",
  "18797 18656 1454080 04-20:33:20 /x/node /x/chrome-devtools-mcp/build/main.js --headless --userDataDir=/d/chrome-profile",
  "18900 18797 500000    04:00:00 /Applications/Google Chrome --headless",
  "18901 18900 250000       59:59 Google Chrome Helper",
  "  777     1 99999       10:00 /x/mcp-proxy --port 45000 -- /x/other",
].join("\n");

describe("process table", () => {
  it("parses ps elapsed time in every form", () => {
    expect(parseEtime("59")).toBe(59);
    expect(parseEtime("01:05")).toBe(65);
    expect(parseEtime("02:01:05")).toBe(7265);
    expect(parseEtime("04-20:33:21")).toBe(4 * 86400 + 20 * 3600 + 33 * 60 + 21);
  });

  it("finds the server behind the bridge on its port and sums the browser it launched", () => {
    const found = findSharedServer(parsePs(PS), 39100)!;
    expect(found.server.pid).toBe(18797);
    expect(found.server.rssKb).toBe(1454080);
    expect(found.treeRssKb).toBe(1454080 + 500000 + 250000);
  });

  it("answers null for a port nothing bridges, and for a bridge with no server below it", () => {
    expect(findSharedServer(parsePs(PS), 39101)).toBeNull();
    expect(findSharedServer(parsePs(PS), 45000)).toBeNull();
  });
});

describe("server mode, read from the running command", () => {
  const server = (flags: string) => `/x/node /x/chrome-devtools-mcp/build/main.js ${flags}`;

  it("tells our default, the owner's Chrome, and anything else apart", () => {
    expect(serverMode(server(`--headless --userDataDir=${PROFILE}`), PROFILE)).toBe("headless-profile");
    expect(serverMode(server("--autoConnect"), PROFILE)).toBe("autoConnect");
    expect(serverMode(server("--headless"), PROFILE)).toBe("foreign");
    expect(serverMode(server(`--userDataDir=${PROFILE}`), PROFILE)).toBe("foreign");
  });
});

describe("restart budget", () => {
  it("defaults to 1024 MB and takes a valid env override only", () => {
    expect(maxMb({})).toBe(DEFAULT_MAX_MB);
    expect(maxMb({ BRAIN_CHROME_SERVER_MAX_MB: "2048" })).toBe(2048);
    expect(maxMb({ BRAIN_CHROME_SERVER_MAX_MB: "abc" })).toBe(DEFAULT_MAX_MB);
    expect(maxMb({ BRAIN_CHROME_SERVER_MAX_MB: "0" })).toBe(DEFAULT_MAX_MB);
  });

  it("is over only past the budget", () => {
    expect(assess(1024 * 1024, 1024).over).toBe(false);
    expect(assess(1024 * 1024 + 2048, 1024)).toEqual({ rssMb: 1026, maxMb: 1024, over: true });
  });
});

describe("hook line when the server is over budget", () => {
  const call = { tool_name: "mcp__chrome-devtools__new_page" };

  it("adds the size only when over budget, and stays silent for other tools", () => {
    expect(browserRouteNotice(call)).not.toContain("MB");
    expect(browserRouteNotice(call, { rssMb: 1500, maxMb: 1024 })).toContain("1500 MB (budget 1024 MB)");
    expect(browserRouteNotice({ tool_name: "Bash" }, { rssMb: 1500, maxMb: 1024 })).toBeNull();
  });
});
