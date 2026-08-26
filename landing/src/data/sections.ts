/**
 * The page's section vocabulary, in one place.
 *
 * The nav renders this twice (inline links and the phone strip) and the footer
 * renders it again. Three copies of the same five strings is how a page ends up
 * calling the same anchor "Recipes" in one spot and "What to ask it" in another.
 */
export interface Section {
  href: string;
  /** Nav label. Kept short — the phone strip puts all five on one line. */
  label: string;
}

export const SECTIONS: Section[] = [
  // Named for what the section shows — two cards, semantic and structural —
  // rather than the "How it works" every site uses.
  { href: "#how", label: "The two brains" },
  { href: "#start", label: "Quick start" },
  { href: "#tools", label: "Tools" },
  // Was "Recipes". That word carries over from the README, where the reader
  // already knows what the tool is; on a landing page it hides the section.
  { href: "#recipes", label: "What to ask it" },
  { href: "#install", label: "Install" },
];
