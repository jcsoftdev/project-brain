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

const luminance = (rgb: [number, number, number]): number => {
  const [r, g, b] = rgb.map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** WCAG 2.x contrast ratio (1..21) between two `#rrggbb` colours; NaN when either is not one. */
export function contrast(a: string, b: string): number {
  const first = channels(a);
  const second = channels(b);
  if (!first || !second) return Number.NaN;
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The colour a little closer to white: the "shimmer" a highlighted row pulses to. */
export const lighten = (hex: string, share = 0.25): string => blend(hex, "#ffffff", share);
