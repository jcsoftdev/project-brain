import { describe, it, expect } from "bun:test";
import { buildStatus, formatStatus } from "../../src/browser/status.js";
import { serviceFilePath, SERVICE_LABEL } from "../../src/setup/chrome-shared-server.js";

const probe = (over: boolean) => ({
  port: 39100,
  pid: 7,
  mode: "headless-profile" as const,
  ageSec: 90_000,
  serverRssMb: over ? 1500 : 300,
  treeRssMb: 900,
  budget: { rssMb: over ? 1500 : 300, maxMb: 1024, over },
});
const base = { profile: "/d/chrome-profile", profileUsed: true, pageCount: 3, restartCommand: "restart-it" };

describe("browser status", () => {
  it("reports what it can when nothing is running, and the bridge as unavailable", () => {
    const s = buildStatus({ ...base, probe: null, pageCount: null });
    expect(s).toMatchObject({ running: false, mode: "not running", server: null, budget: null, pages: "unavailable" });
    expect(formatStatus(s).join("\n")).toContain("not running");
  });

  it("flags over budget and names the restart command only then", () => {
    const over = buildStatus({ ...base, probe: probe(true) });
    expect(over.budget).toEqual({ maxMb: 1024, over: true });
    expect(over.restartCommand).toBe("restart-it");
    expect(formatStatus(over).join("\n")).toContain("OVER BUDGET");

    const within = buildStatus({ ...base, probe: probe(false) });
    expect(within.restartCommand).toBeNull();
    expect(formatStatus(within).join("\n")).toContain("within budget");
  });

  it("points an uninitialised profile at the login command", () => {
    const s = buildStatus({ ...base, probe: probe(false), profileUsed: false });
    expect(formatStatus(s).join("\n")).toContain("project-brain browser login");
  });

  it("names the service file this tool installs, per platform", () => {
    expect(serviceFilePath("launchd", "/h")).toBe(`/h/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
    expect(serviceFilePath("systemd", "/h")).toBe(`/h/.config/systemd/user/${SERVICE_LABEL}.service`);
  });
});
