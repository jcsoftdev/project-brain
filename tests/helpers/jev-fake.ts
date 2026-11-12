/**
 * A Jev reply built from the request it answers: each `skill_<i>` judgment comes from `skills`
 * by the name at `state.skills[i]` (0.05 when unnamed), each choice question from `choices`.
 */
export function jevReply(
  body: { questions: Record<string, { type: string }>; state: { skills?: Array<{ name: string }> } },
  skills: Record<string, number> = {},
  choices: Record<string, { choice: string; p: number }> = {}
): Response {
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(body.questions)) {
    const skillIndex = /^skill_(\d+)$/.exec(key)?.[1];
    if (skillIndex !== undefined) {
      answers[key] = { noul: skills[body.state.skills?.[Number(skillIndex)]?.name ?? ""] ?? 0.05 };
    } else if (question.type === "choice") {
      const { choice, p } = choices[key] ?? { choice: "none", p: 0.9 };
      answers[key] = { choice, confidence: p, probabilities: { [choice]: p, none: 1 - p } };
    }
  }
  return new Response(JSON.stringify({ answers }));
}
