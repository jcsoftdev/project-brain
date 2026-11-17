-- Turns a theme palette (lua/project-brain/palette.lua) into highlight groups for tokyonight.
-- The palette changes per theme; this file does not: every role below is a palette colour or a blend of two.
local M = {}

local function channels(hex)
  hex = hex:gsub("^#", "")
  return tonumber(hex:sub(1, 2), 16), tonumber(hex:sub(3, 4), 16), tonumber(hex:sub(5, 6), 16)
end

--- `from` moved `share` (0..1) of the way towards `into`.
function M.blend(from, into, share)
  local r1, g1, b1 = channels(from)
  local r2, g2, b2 = channels(into)
  local function mix(a, b)
    return math.floor(a + (b - a) * share + 0.5)
  end
  return string.format("#%02x%02x%02x", mix(r1, r2), mix(g1, g2), mix(b1, b2))
end

--- Tokyonight's colour table, re-pointed at the palette. Runs as `on_colors`.
function M.colors(c, p)
  local a = p.accents
  c.bg, c.bg_dark, c.bg_sidebar, c.bg_statusline = p.background, p.background, p.background, p.background
  c.bg_float = M.blend(p.background, p.selection, 0.5)
  c.bg_highlight = M.blend(p.background, p.selection, 0.45)
  c.bg_visual = p.selection
  c.bg_popup = c.bg_float
  c.fg, c.fg_dark, c.fg_float = p.foreground, M.blend(p.foreground, p.background, 0.15), p.foreground
  c.fg_gutter = p.comment
  c.comment = p.comment
  c.dark3, c.dark5 = p.comment, M.blend(p.comment, p.foreground, 0.35)
  c.terminal_black = p.ansi[1]
  c.red, c.red1 = a.red, a.red
  c.orange, c.yellow = a.orange, a.yellow
  c.green, c.green1, c.green2 = a.green, a.green, a.green
  c.cyan, c.teal, c.blue1, c.blue2, c.blue5, c.blue6 = a.cyan, a.cyan, a.cyan, a.cyan, a.cyan, a.cyan
  c.blue, c.blue0, c.purple = a.purple, a.purple, a.purple
  c.magenta, c.magenta2 = a.pink, a.pink
  c.border, c.border_highlight = p.comment, a.purple
  c.error, c.warning, c.info, c.hint = a.red, a.orange, a.cyan, a.purple
  c.git = { add = a.green, change = a.orange, delete = a.red, ignore = p.comment }
  c.gitSigns = { add = a.green, change = a.orange, delete = a.red }
  c.diff = {
    add = M.blend(p.background, a.green, 0.16),
    delete = M.blend(p.background, a.red, 0.16),
    change = M.blend(p.background, a.cyan, 0.07),
    text = M.blend(p.background, a.orange, 0.32),
  }
end

--- Highlight groups that follow how the theme paints code (pink keywords, green functions, yellow strings...) and
--- make diffs readable. Runs as `on_highlights`, after tokyonight's own groups, so it only needs to name what differs.
function M.groups(hl, c, p)
  local a = p.accents
  local bg, fg = p.background, p.foreground
  local function tint(accent, share)
    return M.blend(bg, accent, share)
  end
  local function set(name, spec)
    hl[name] = spec
  end

  -- Diff: green is added, red is removed, a changed line is only faintly tinted so the changed words stand out.
  set("DiffAdd", { bg = tint(a.green, 0.16) })
  set("DiffChange", { bg = tint(a.cyan, 0.07) })
  set("DiffDelete", { bg = tint(a.red, 0.16), fg = M.blend(a.red, bg, 0.5) })
  set("DiffText", { bg = tint(a.orange, 0.32), bold = true })
  set("DiffTextAdd", { bg = tint(a.green, 0.34), bold = true })
  set("diffAdded", { fg = a.green })
  set("diffRemoved", { fg = a.red })
  set("diffChanged", { fg = a.orange })
  set("diffFile", { fg = a.purple, bold = true })
  set("diffLine", { fg = a.cyan })
  set("GitSignsAdd", { fg = a.green })
  set("GitSignsChange", { fg = a.orange })
  set("GitSignsDelete", { fg = a.red })
  set("GitSignsAddInline", { bg = tint(a.green, 0.34) })
  set("GitSignsChangeInline", { bg = tint(a.orange, 0.32) })
  set("GitSignsDeleteInline", { bg = tint(a.red, 0.34) })
  set("GitSignsAddLn", { bg = tint(a.green, 0.16) })
  set("GitSignsChangeLn", { bg = tint(a.orange, 0.1) })
  set("GitSignsDeleteLn", { bg = tint(a.red, 0.16) })
  set("GitSignsAddPreview", { bg = tint(a.green, 0.16) })
  set("GitSignsDeletePreview", { bg = tint(a.red, 0.16) })

  -- Syntax.
  local function many(names, spec)
    for _, name in ipairs(names) do
      set(name, spec)
    end
  end
  set("Comment", { fg = p.comment, italic = true })
  set("@comment", { fg = p.comment, italic = true })
  many({ "Keyword", "Statement", "Conditional", "Repeat", "Exception", "Operator", "Include",
    "@keyword", "@keyword.return", "@keyword.conditional", "@keyword.repeat", "@keyword.import",
    "@keyword.exception", "@keyword.operator", "@keyword.modifier", "@keyword.coroutine", "@operator",
    "@lsp.type.keyword", "@lsp.type.operator" }, { fg = a.pink })
  many({ "Function", "@function", "@function.call", "@function.method", "@function.method.call",
    "@lsp.type.function", "@lsp.type.method" }, { fg = a.green })
  many({ "@keyword.function" }, { fg = a.pink })
  many({ "@function.builtin", "@variable.builtin" }, { fg = a.cyan, italic = true })
  many({ "Type", "Structure", "@type", "@constructor", "@lsp.type.class", "@lsp.type.interface",
    "@lsp.type.enum", "@lsp.type.struct", "@lsp.type.type", "@lsp.type.typeParameter", "@module", "@namespace" },
    { fg = a.cyan })
  many({ "@type.builtin" }, { fg = a.cyan, italic = true })
  many({ "String", "Character", "@string", "@character", "@lsp.type.string" }, { fg = a.yellow })
  many({ "@string.escape", "@string.special" }, { fg = a.pink })
  many({ "@string.regexp" }, { fg = a.orange })
  many({ "Number", "Float", "Boolean", "Constant", "@number", "@number.float", "@boolean", "@constant",
    "@constant.builtin", "@lsp.type.enumMember" }, { fg = a.purple })
  many({ "@variable", "@variable.member", "@property", "@lsp.type.variable", "@lsp.type.property",
    "@punctuation.delimiter", "@punctuation.bracket" }, { fg = fg })
  many({ "@variable.parameter", "@lsp.type.parameter" }, { fg = a.orange, italic = true })
  many({ "@tag", "@tag.builtin" }, { fg = a.pink })
  many({ "@tag.attribute", "@attribute", "@lsp.type.decorator" }, { fg = a.green })
  many({ "@tag.delimiter" }, { fg = p.comment })
  many({ "@markup.heading", "@markup.heading.1", "@markup.heading.2", "@markup.heading.3", "@markup.heading.4",
    "@markup.heading.5", "@markup.heading.6" }, { fg = a.purple, bold = true })
  set("@markup.strong", { bold = true })
  set("@markup.italic", { italic = true })
  many({ "@markup.link", "@markup.link.url" }, { fg = a.cyan, underline = true })
  set("@markup.raw", { fg = a.green })

  -- Diagnostics.
  set("DiagnosticError", { fg = a.red })
  set("DiagnosticWarn", { fg = a.orange })
  set("DiagnosticInfo", { fg = a.cyan })
  set("DiagnosticHint", { fg = a.purple })
  set("DiagnosticUnderlineError", { undercurl = true, sp = a.red })
  set("DiagnosticUnderlineWarn", { undercurl = true, sp = a.orange })
  set("DiagnosticUnderlineInfo", { undercurl = true, sp = a.cyan })
  set("DiagnosticUnderlineHint", { undercurl = true, sp = a.purple })

  -- Editor chrome.
  set("CursorLine", { bg = tint(p.selection, 0.45) })
  set("CursorLineNr", { fg = a.orange, bold = true })
  set("LineNr", { fg = p.comment })
  set("Visual", { bg = p.selection })
  set("Search", { bg = tint(a.orange, 0.35), fg = fg })
  set("IncSearch", { bg = a.orange, fg = bg })
  set("MatchParen", { fg = a.pink, bold = true })
  set("WinSeparator", { fg = M.blend(p.comment, bg, 0.4) })
  set("NonText", { fg = M.blend(p.comment, bg, 0.5) })
  set("FloatBorder", { fg = p.comment, bg = c.bg_float })
  set("NormalFloat", { fg = fg, bg = c.bg_float })
  set("Pmenu", { fg = fg, bg = c.bg_float })
  set("PmenuSel", { bg = p.selection })
  set("PmenuBorder", { fg = p.comment, bg = c.bg_float })
end

return M
