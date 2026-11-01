import type { ToolSet } from "./tool_set.js";

/**
 * The MCP `instructions` sent to the host at initialize, once per session. Claude Code keeps
 * only about the first 2000 characters (measured 2026-09-29), so the whole text stays under
 * INSTRUCTIONS_MAX, most important first; the rest belongs in tool descriptions. The exception:
 * when the browser is not installed at startup a note goes first, and with all tools the last
 * sentence (browser_run_task's) may then be dropped for that session. The note says what happens,
 * not "being installed now": instructions are sent once and would go stale when it finishes.
 */
export const INSTRUCTIONS_MAX = 2000;

const BROWSER_TOOLS = `Search the web and read pages with these tools, not a built-in web search or fetch tool (WebSearch, WebFetch): you get the page's own text, not another model's summary, including pages built by scripts and sites the person is signed in to.
- Read: pass the URLs to browser_read_pages, several at once.
- Search: open the engine's or the site's home page with browser_new_tab and type the query into its search box (browser_input_text, pressEnter); a results URL opened directly often meets a captcha. Snapshot the results with showLinks and pass the addresses of the results (not ads) to browser_read_pages; redirect addresses are fine. A result with no address: middle-click it and snapshot the new tab with tabIds.
- Sign-in, payment and captchas are for a person; never solve a captcha yourself. browser_start_human_control hands the tab over; snapshot until they are done, then browser_stop_human_control. With no one to answer, stop and say so.

To act on a page: browser_take_snapshot, act by the element numbers (emsn) with its snapshotId, snapshot again. Prefer browser_batch, even for one action: it returns the fresh snapshot. Snapshot before acting on an element an earlier step makes appear.
- "12 INPUT:text [name] ="value"": 12 is the emsn; hint "..." is a placeholder, not a value. "·" lines are text only; a Tab indent means inside the line above. Offscreen elements are acted on by number too.
- Ask for includeImage when the look matters: which option is selected, greyed-out dates, a chart.
- Clear "popups blocking this tab" with browser_close_popup_bubble first. Values already in a form are left over: check them. Set a SELECT or date field with browser_input_text.

Other sessions may share this browser: work in tabs you opened with browser_new_tab and pass their tabId to every call that acts on a tab.`;

const TASK_TOOLS = `browser_run_task runs a whole task given in plain language with its own model, pausing for a person at sign-in, payment and captchas; browser_stop_task stops it.`;

const INSTALLING = `BrowserDo first downloads and installs the Embiody browser, which can take about 5 minutes; until it is ready each tool replies with the progress instead of acting.`;

export function instructionsFor(toolSet: ToolSet, installing = false): string {
  const text =
    toolSet === "task" ? TASK_TOOLS : toolSet === "browser" ? BROWSER_TOOLS : `${BROWSER_TOOLS}\n\n${TASK_TOOLS}`;
  return installing ? `${INSTALLING}\n\n${text}` : text;
}
