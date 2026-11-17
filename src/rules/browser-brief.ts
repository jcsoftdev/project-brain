/**
 * The browser limits a delegation carries as text.
 *
 * A sub-agent opens pages in whatever browser its tools reach, and nothing stops it from opening ten. With the
 * shared server attached to the owner's own Chrome (`--autoConnect`), four agents in parallel opened about ten
 * pages, one grew to 3 GB, Chrome slowed down and the MCP stopped answering; the agents could no longer close
 * what they had opened. These limits go in the brief itself, because a sub-agent reads its brief and not the
 * skills of the session that spawned it.
 */

export const BROWSER_BRIEF_HEADING = "## Browser limits";

export const BROWSER_BRIEF = `${BROWSER_BRIEF_HEADING}

- Your own browser work goes in the shared headless browser (chrome-devtools), never in the owner's Chrome. Open every page with \`new_page\` and an \`isolatedContext\` named \`<agent>-<role>\`: the same name shares a session (several tabs of one user), different names isolate cookies and storage (owner and cashier at once).
- At most 4 pages open at the same time.
- Close every page you opened before you finish, even when the task fails.
- Do not use claude-in-chrome unless the owner asked for it in this task, and do not use Playwright as your browser (the repository's e2e suite stays on Playwright: it is the test runner, not your browser).
- If chrome-devtools calls start timing out, stop: report it and open no more pages. \`project-brain browser status\` shows the server's mode and its open pages.`;

const MENTIONS_BROWSER =
  /\b(?:browser|browsers|chrome|chromium|devtools|navegador|playwright|e2e|end-to-end|screenshot|new_page|localhost|walkthrough)\b/i;

export function mentionsBrowser(prompt: string): boolean {
  return MENTIONS_BROWSER.test(prompt);
}

/** The prompt with the limits appended once; unchanged when it is not about a browser or already carries them. */
export function withBrowserBrief(prompt: string): string {
  if (!mentionsBrowser(prompt) || prompt.includes(BROWSER_BRIEF_HEADING)) return prompt;
  return `${prompt.trimEnd()}\n\n${BROWSER_BRIEF}\n`;
}
