import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guidanceUnits, type SetupContext } from "../../src/setup/units.js";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";
import { ROUTING_CONTENT_VERSION } from "../../src/constants.js";
import { writeSection } from "../../src/rules/section-marker.js";
import { ROUTING_SECTION_ID } from "../../src/registrars/routing-section.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-routing-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const unit = () => guidanceUnits().find((u) => u.id === "guidance:model-routing")!;
const ctxFor = (r: ClaudeRegistrar) =>
  ({ installed: [r], routingConfigPath: join(dir, "none.json") }) as unknown as SetupContext;

describe("model-routing as an on-demand skill", () => {
  it("migrates an old inline block to a pointer plus a skill, and is idempotent", async () => {
    const claudeMd = join(dir, "CLAUDE.md");
    await writeFile(claudeMd, "# mine\n\nkeep me\n");
    await writeSection(
      claudeMd,
      "## Model routing for delegated agents\n\n<!-- model-routing-version: 4 -->\n" + "old body\n".repeat(100),
      ROUTING_SECTION_ID
    );
    const registrar = new ClaudeRegistrar(dir);
    expect(await unit().inspect(ctxFor(registrar))).toBe("stale");

    await unit().apply(ctxFor(registrar));
    const rules = await readFile(claudeMd, "utf8");
    expect(rules).toContain("keep me");
    expect(rules).toContain("`brain-model-routing`");
    expect(rules).toContain(`model-routing-version: ${ROUTING_CONTENT_VERSION}`);
    expect(rules).not.toContain("old body");
    expect(rules.length).toBeLessThan(1200);

    const skill = await readFile(join(dir, "skills", "brain-model-routing", "SKILL.md"), "utf8");
    expect(skill).toContain("generator: project-brain");
    expect(skill).toContain("| Task | Tier |");
    expect(await unit().inspect(ctxFor(registrar))).toBe("current");

    await unit().apply(ctxFor(registrar));
    expect(await readFile(claudeMd, "utf8")).toBe(rules);
    expect(await readFile(join(dir, "skills", "brain-model-routing", "SKILL.md"), "utf8")).toBe(skill);
  });

  it("reports stale when the pointer survives but the skill was deleted", async () => {
    const registrar = new ClaudeRegistrar(dir);
    await unit().apply(ctxFor(registrar));
    await rm(join(dir, "skills"), { recursive: true });
    expect(await unit().inspect(ctxFor(registrar))).toBe("stale");
  });

  it("keeps the guidance inline when a hand-written skill occupies the name", async () => {
    const skillDir = join(dir, "skills", "brain-model-routing");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: brain-model-routing\n---\nmine\n");
    const registrar = new ClaudeRegistrar(dir);
    await unit().apply(ctxFor(registrar));

    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("mine");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("| Task | Tier |");
  });

  it("remove deletes the skill only when it is ours", async () => {
    const registrar = new ClaudeRegistrar(dir);
    await unit().apply(ctxFor(registrar));
    await unit().remove!(ctxFor(registrar));
    expect(existsSync(join(dir, "skills", "brain-model-routing"))).toBe(false);
  });
});
