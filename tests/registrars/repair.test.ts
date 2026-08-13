import { describe, it, expect } from "bun:test";
import { repairLaunchEntry } from "../../src/registrars/repair.js";

describe("repairLaunchEntry", () => {
  it("rewrites a bun-prefixed compiled binary to a direct spawn", () => {
    expect(
      repairLaunchEntry({
        command: "bun",
        args: ["/opt/homebrew/bin/project-brain"],
        transport: "stdio",
      })
    ).toEqual({
      command: "/opt/homebrew/bin/project-brain",
      args: [],
      transport: "stdio",
    });
  });

  it("preserves unrelated keys on the entry it repairs", () => {
    // VS Code uses `type`, not `transport`, and a user may have added env of
    // their own. A repair that drops either is a different kind of breakage.
    expect(
      repairLaunchEntry({
        type: "stdio",
        command: "bun",
        args: ["/usr/local/bin/project-brain"],
        env: { BRAIN_DATA_DIR: "/data" },
      })
    ).toEqual({
      type: "stdio",
      command: "/usr/local/bin/project-brain",
      args: [],
      env: { BRAIN_DATA_DIR: "/data" },
    });
  });

  it("leaves a bun-run source entrypoint alone — that one is correct", () => {
    expect(
      repairLaunchEntry({
        command: "bun",
        args: ["/repo/src/cli.ts"],
        transport: "stdio",
      })
    ).toBeNull();
  });

  it("leaves an already-repaired direct spawn alone", () => {
    expect(
      repairLaunchEntry({
        command: "/opt/homebrew/bin/project-brain",
        args: [],
        transport: "stdio",
      })
    ).toBeNull();
  });

  it("leaves a bun invocation carrying extra runtime flags alone", () => {
    // `bun --smol <path>` is a deliberate user customization, not the shape
    // setup wrote. Repairing it would silently drop their flag.
    expect(
      repairLaunchEntry({
        command: "bun",
        args: ["--smol", "/opt/homebrew/bin/project-brain"],
      })
    ).toBeNull();
  });

  it("returns null for an entry with no args array", () => {
    expect(repairLaunchEntry({ command: "bun" })).toBeNull();
  });

  it("returns null for a non-object entry", () => {
    expect(repairLaunchEntry(null as any)).toBeNull();
    expect(repairLaunchEntry("bun" as any)).toBeNull();
  });
});
