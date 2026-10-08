import { join } from "node:path";
import { JEV_ARCH_VIOLATION_MIN_PROBABILITY } from "../constants.js";
import { anchorCovers, collectAnchors } from "../okf/anchors.js";
import { readBundle } from "../okf/bundle.js";
import { ask, type AskOptions, type ChoiceAnswer, type ChoiceQuestion } from "../typesafe/client.js";

/**
 * The fuzzy half of `arch-guard`: OKF `Constraint` concepts that cover the
 * edited file, put to Jev as yes/no questions.
 *
 * A constraint is prose ("persistence must not leak into the domain model"),
 * which no import graph can check. Jev reads it next to the edit and says how
 * likely the edit is to break it; only a confident yes blocks.
 */

export interface CoveringConstraint {
  /** Bundle-relative path of the concept, e.g. `constraints/no-db-in-domain.md`. */
  concept: string;
  title: string;
  body: string;
}

export interface ConstraintViolation extends CoveringConstraint {
  /** Jev's probability that the edit violates the constraint. */
  probability: number;
}

/** The edit as Jev sees it. Only the fields the tool carries are set. */
export interface EditSnapshot {
  tool: string;
  content?: string;
  oldString?: string;
  newString?: string;
  edits?: { oldString: string; newString: string }[];
}

export type ArchAsk = (
  token: string,
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  options?: AskOptions
) => Promise<Record<string, ChoiceAnswer> | null>;

/**
 * At most this many constraints go to Jev per edit, most specific anchor first.
 * Every one is another question in the same request, and a directory that dozens
 * of broad constraints cover would otherwise make each edit slow and costly.
 */
const MAX_CONSTRAINTS = 10;
const MAX_BODY_CHARS = 2000;
const MAX_EDIT_CHARS = 4000;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

/**
 * Constraint concepts whose anchors cover `file`. A concept without an anchor
 * covers nothing: there is no way to know which edits it is about, and asking
 * about every constraint on every edit would be noise and cost.
 */
export async function loadCoveringConstraints(root: string, file: string): Promise<CoveringConstraint[]> {
  let bundle;
  try {
    bundle = await readBundle(join(root, "okf"));
  } catch {
    return []; // no bundle is the normal case, not an error
  }

  const anchors = collectAnchors(bundle, { bundleRoot: bundle.root, repoRoot: root });
  // A file anchor beats any directory anchor; among directories the deeper one is more specific.
  const specificity = new Map<string, number>();
  for (const a of anchors) {
    if (!anchorCovers(a, file)) continue;
    const score = a.directory ? a.path.split("/").length : Number.MAX_SAFE_INTEGER;
    specificity.set(a.concept, Math.max(specificity.get(a.concept) ?? 0, score));
  }

  const out: CoveringConstraint[] = [];
  for (const entry of bundle.files) {
    if (entry.kind !== "concept" || entry.document.frontmatter.type !== "Constraint") continue;
    if (!specificity.has(entry.path)) continue;
    const title = entry.document.frontmatter.title;
    out.push({
      concept: entry.path,
      title: typeof title === "string" && title !== "" ? title : entry.path,
      body: entry.document.body,
    });
  }
  const rank = (c: CoveringConstraint) => specificity.get(c.concept) ?? 0;
  return out.sort((a, b) => rank(b) - rank(a)).slice(0, MAX_CONSTRAINTS);
}

function snapshotState(edit: EditSnapshot): Record<string, unknown> {
  if (edit.tool === "Write") return { newContent: truncate(edit.content ?? "", MAX_EDIT_CHARS) };
  if (edit.edits) {
    return {
      edits: edit.edits.map((e) => ({
        old: truncate(e.oldString, MAX_EDIT_CHARS / edit.edits!.length),
        new: truncate(e.newString, MAX_EDIT_CHARS / edit.edits!.length),
      })),
    };
  }
  return { old: truncate(edit.oldString ?? "", MAX_EDIT_CHARS / 2), new: truncate(edit.newString ?? "", MAX_EDIT_CHARS / 2) };
}

function questionFor(id: string): ChoiceQuestion {
  return {
    type: "choice",
    instructions:
      `Judge the edit in \`state.edit\` to the file \`state.file\` against the project constraint \`state.constraints.${id}\` ` +
      "(a title and a body saying what must keep holding). Does this edit violate that constraint?",
    criteria: {
      yes: "the edit breaks what the constraint says must hold, or clearly moves the code toward breaking it",
      no: "the edit leaves the constraint intact, or has nothing to do with it",
    },
  };
}

function probabilityOfViolation(answer: ChoiceAnswer): number {
  const p = answer.probabilities.yes;
  if (typeof p === "number") return p;
  return answer.choice === "yes" ? answer.confidence : 0;
}

export interface JudgeOptions extends AskOptions {
  ask?: ArchAsk;
  threshold?: number;
}

/**
 * Constraints Jev is confident the edit violates. One `ask()` call for all of
 * them. Resolves to [] on any failure (no answer, timeout, malformed): this layer
 * is advisory, and a network blip must never stop an edit.
 */
export async function judgeConstraints(
  token: string,
  constraints: CoveringConstraint[],
  file: string,
  edit: EditSnapshot,
  options: JudgeOptions = {}
): Promise<ConstraintViolation[]> {
  if (constraints.length === 0) return [];

  const state: Record<string, unknown> = { file, edit: snapshotState(edit), constraints: {} };
  const questions: Record<string, ChoiceQuestion> = {};
  constraints.forEach((c, i) => {
    const id = `c${i}`;
    (state.constraints as Record<string, unknown>)[id] = { title: c.title, body: truncate(c.body, MAX_BODY_CHARS) };
    questions[id] = questionFor(id);
  });

  const { ask: askFn = ask as ArchAsk, threshold = JEV_ARCH_VIOLATION_MIN_PROBABILITY, ...askOptions } = options;
  const answers = await askFn(token, state, questions, askOptions);
  if (!answers) return [];

  const violations: ConstraintViolation[] = [];
  constraints.forEach((c, i) => {
    const answer = answers[`c${i}`];
    if (!answer) return;
    const probability = probabilityOfViolation(answer);
    if (probability > threshold) violations.push({ ...c, probability });
  });
  return violations;
}
