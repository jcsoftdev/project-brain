import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/atomic-write.js";

describe("writeFileAtomic", () => {
  it("keeps the mode of an existing target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-atomic-"));
    const file = join(dir, "settings.json");
    await writeFile(file, "old");
    await chmod(file, 0o600);

    await writeFileAtomic(file, "new");

    expect(await readFile(file, "utf-8")).toBe("new");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("creates a missing file with the default mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-atomic-"));
    const file = join(dir, "sub", "new.json");

    await writeFileAtomic(file, "x");

    expect(await readFile(file, "utf-8")).toBe("x");
  });
});
