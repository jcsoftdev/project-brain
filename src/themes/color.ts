const channels = (hex: string): [number, number, number] | undefined => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** `hex` moved `share` (0..1) of the way towards `into`; anything that is not a 6-digit hex comes back unchanged. */
export function blend(hex: string, into: string, share: number): string {
  const from = channels(hex);
  const to = channels(into);
  if (!from || !to) return hex;
  const t = Math.min(1, Math.max(0, share));
  const mixed = from.map((channel, at) => Math.round(channel + (to[at]! - channel) * t));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** The colour a little closer to white: the "shimmer" a highlighted row pulses to. */
export const lighten = (hex: string, share = 0.25): string => blend(hex, "#ffffff", share);
