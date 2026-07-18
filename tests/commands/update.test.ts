import { test, expect, describe } from "bun:test";
import { runUpdate } from "../../src/commands/update.js";

describe("runUpdate", () => {
  const baseDeps = () => {
    const logged: string[] = [];
    const spawned: string[][] = [];
    return {
      logged,
      spawned,
      deps: {
        currentVersion: "0.6.0",
        binPath: "/Users/x/.bun/bin/project-brain",
        env: {} as Record<string, string | undefined>,
        fetchLatest: async () => "0.7.0" as string | null,
        spawnUpdate: async (argv: string[]) => {
          spawned.push(argv);
          return 0;
        },
        log: (m: string) => logged.push(m),
      },
    };
  };

  test("already on the latest version: does not spawn, reports up to date", async () => {
    const h = baseDeps();
    h.deps.fetchLatest = async () => "0.6.0";
    const result = await runUpdate(h.deps);

    expect(result.alreadyLatest).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(h.spawned.length).toBe(0);
    expect(h.logged.join("\n")).toContain("up to date");
  });

  test("newer version available: spawns the manager's update argv for the detected install path", async () => {
    const h = baseDeps();
    const result = await runUpdate(h.deps);

    expect(result.alreadyLatest).toBe(false);
    expect(result.manager).toBe("bun");
    expect(h.spawned.length).toBe(1);
    expect(h.spawned[0]).toEqual(["bun", "add", "-g", "project-brain@latest"]);
    expect(result.exitCode).toBe(0);
  });

  test("logs the version arrow (current → latest) before updating", async () => {
    const h = baseDeps();
    await runUpdate(h.deps);
    const logged = h.logged.join("\n");
    expect(logged).toContain("0.6.0");
    expect(logged).toContain("0.7.0");
  });

  test("registry fetch fails (returns null): still runs the update as best-effort, no version arrow", async () => {
    const h = baseDeps();
    h.deps.fetchLatest = async () => null;
    const result = await runUpdate(h.deps);

    expect(result.alreadyLatest).toBe(false);
    expect(h.spawned.length).toBe(1);
    expect(result.latest).toBeNull();
  });

  test("registry fetch throws: fail-safe, still runs the update", async () => {
    const h = baseDeps();
    h.deps.fetchLatest = async () => {
      throw new Error("network down");
    };
    const result = await runUpdate(h.deps);

    expect(result.alreadyLatest).toBe(false);
    expect(h.spawned.length).toBe(1);
  });

  test("propagates the spawned process's exit code", () => {
    const h = baseDeps();
    h.deps.spawnUpdate = async () => 1;
    return runUpdate(h.deps).then((result) => {
      expect(result.exitCode).toBe(1);
    });
  });

  test("picks the correct argv per detected install manager", async () => {
    const h = baseDeps();
    h.deps.binPath = "/usr/local/lib/node_modules/.bin/project-brain";
    const result = await runUpdate(h.deps);

    expect(result.manager).toBe("npm");
    expect(h.spawned[0]).toEqual(["npm", "install", "-g", "project-brain@latest"]);
  });
});
