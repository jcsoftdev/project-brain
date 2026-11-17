import type { ThemeDefinition } from "./types.js";

/** Dracula's published colours and standard ANSI set; the background is the owner's own (#17141d), not Dracula's #282a36. */
export const DRACULA: ThemeDefinition = {
  id: "dracula",
  label: "Dracula",
  background: "#17141d",
  foreground: "#f8f8f2",
  selection: "#44475a",
  comment: "#6272a4",
  accents: {
    red: "#ff5555",
    orange: "#ffb86c",
    yellow: "#f1fa8c",
    green: "#50fa7b",
    cyan: "#8be9fd",
    purple: "#bd93f9",
    pink: "#ff79c6",
  },
  ansi: [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ],
};
