import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("selection file", () => {
  it("round-trips a selection and derives declined from the full id list", async () => {
    const { saveSelection, loadSelection } = await import("../../src/setup/selection.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-selection-"));
    const path = join(dir, "setup-selection.json");

    await saveSelection(path, ["skill:brain-audit"], ["skill:brain-audit", "skill:brain-okf"], "0.27.0");
    const loaded = await loadSelection(path);

    expect(loaded?.selected).toEqual(["skill:brain-audit"]);
    expect(loaded?.declined).toEqual(["skill:brain-okf"]);
    expect(loaded?.binaryVersion).toBe("0.27.0");
    expect(loaded?.version).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports the three-way membership that drives the checklist", async () => {
    const { membership } = await import("../../src/setup/selection.js");
    const selection = {
      version: 1 as const,
      updatedAt: "2026-09-08T00:00:00.000Z",
      binaryVersion: "0.26.0",
      selected: ["skill:brain-audit"],
      declined: ["skill:brain-okf"],
    };

    expect(membership(selection, "skill:brain-audit")).toBe("selected");
    expect(membership(selection, "skill:brain-okf")).toBe("declined");
    // Shipped after the last run: in neither list.
    expect(membership(selection, "skill:brain-worktree")).toBe("unseen");
  });

  it("treats every id as unseen when no selection has ever been saved", async () => {
    const { loadSelection, membership } = await import("../../src/setup/selection.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-selection-absent-"));

    const loaded = await loadSelection(join(dir, "setup-selection.json"));
    expect(loaded).toBeNull();
    expect(membership(loaded, "skill:brain-audit")).toBe("unseen");

    await rm(dir, { recursive: true, force: true });
  });

  it("returns null on a corrupt file rather than throwing", async () => {
    const { loadSelection } = await import("../../src/setup/selection.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-selection-corrupt-"));
    const path = join(dir, "setup-selection.json");
    await writeFile(path, "{ not json", "utf8");

    expect(await loadSelection(path)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });
});
