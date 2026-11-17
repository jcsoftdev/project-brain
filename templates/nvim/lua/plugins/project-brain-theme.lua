-- The colour theme: tokyonight (maintained, covers every plugin LazyVim ships) re-pointed at the project-brain palette.
-- To change theme, change the palette; this spec and highlights.lua stay as they are.
return {
  {
    "folke/tokyonight.nvim",
    opts = {
      style = "night",
      transparent = true,
      styles = { sidebars = "transparent", floats = "dark" },
      on_colors = function(colors)
        require("project-brain.highlights").colors(colors, require("project-brain.palette"))
      end,
      on_highlights = function(highlights, colors)
        require("project-brain.highlights").groups(highlights, colors, require("project-brain.palette"))
      end,
    },
  },
  { "LazyVim/LazyVim", opts = { colorscheme = "tokyonight-night" } },
}
