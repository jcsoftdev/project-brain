export const GATE_FENCE_BEGIN = "<!-- project-brain:begin -->";
export const GATE_FENCE_END = "<!-- project-brain:end -->";

export const fencedForGate = (text: string): string => `${GATE_FENCE_BEGIN}\n${text}\n${GATE_FENCE_END}`;
