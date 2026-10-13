import { describe, expect, it } from "bun:test";
import { execute } from "../../src/hooks/routing-rules.js";

async function captureStdout(run: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    await run();
  } finally {
    console.log = real;
  }
  return out;
}

describe("routing-rules execute", () => {
  it("runs the self-install once and still prints a single JSON payload", async () => {
    let installs = 0;
    const out = await captureStdout(() => execute(async () => void (installs += 1)));

    expect(installs).toBe(1);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("still prints the payload when the self-install fails", async () => {
    const out = await captureStdout(() =>
      execute(async () => {
        throw new Error("boom");
      })
    );

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).hookSpecificOutput).toBeDefined();
  });
});
