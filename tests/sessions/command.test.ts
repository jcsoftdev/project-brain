import { describe, it, expect } from "bun:test";
import { execute } from "../../src/commands/sessions.js";
import { parseProcessTable } from "../../src/sessions/model.js";
import type { SessionHost } from "../../src/sessions/host.js";

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

function fakeHost() {
  const killed: number[] = [];
  const host: SessionHost = {
    processTable: () =>
      parseProcessTable(
        ["  10     1 03-00:00:00 claude", "  20     1 03-00:00:00 claude", "  30     1 03-00:00:00 not-claude"].join("\n")
      ),
    memoryMb: () => 100,
    cwd: () => "/p",
    lastActivityMs: (cwd) => (cwd === "/p" ? NOW - 48 * HOUR : null),
    terminate: (pid) => void killed.push(pid),
  };
  return { host, killed };
}

describe("sessions --prune", () => {
  it("sends no signal without --yes", async () => {
    const { host, killed } = fakeHost();
    await execute(["--prune"], host, NOW);
    expect(killed).toEqual([]);
  });

  it("terminates only discovered idle sessions with --yes", async () => {
    const { host, killed } = fakeHost();
    await execute(["--prune", "--yes"], host, NOW);
    expect(killed).toEqual([10, 20]);
  });
});
