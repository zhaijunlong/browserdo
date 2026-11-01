import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CdpClient } from "../cdp-client.js";
import { appendDebugLog } from "../logger.js";
import type { ActionResult } from "../browser-actions.js";
import {
  browserAddNewTab,
  browserClick,
  browserClosePopupBubble,
  browserCloseTab,
  browserCloseWindow,
  browserDrag,
  browserGetWindowInfo,
  browserGoBack,
  browserGoForward,
  browserInputText,
  browserMinimize,
  browserMove,
  browserNavigate,
  browserNewWindow,
  browserPressKey,
  browserReload,
  browserScroll,
  browserSelectTab,
  browserSelectEditableText,
  browserSetAudioMuted,
  browserShow,
  browserStartHumanControl,
  browserStopLoading,
  browserStopHumanControl,
  browserWait,
  describePageType,
  takeSnapshots,
} from "../browser-actions.js";
import { footnoteList, footnotesIn, renderAnnotatedContent, renderWithLinks } from "../annotated_content.js";
import { MAX_SNAPSHOT_TABS } from "../runtime_types.js";
import type { TabSnapshot, WindowInfo } from "../runtime_types.js";

/**
 * The thin tool layer: one MCP tool per browser action, so the host agent runs the loop
 * itself.
 *
 * Why this exists alongside browser_run_task:
 * - **It installs and works with no configuration.** Nothing here calls a model, so no API
 *   key is needed. BrowserDo's job is to be found and installed from a tool registry; a tool
 *   that does nothing until you supply a key gets uninstalled instead.
 * - **It skips a second inference pass.** The host already has a loop. Opening one page and
 *   reading a line off it does not need an agent of its own.
 *
 * The cost is real and cannot be engineered away: every observation lands in the host's
 * context, so a task that takes dozens of rounds will not fit. Long tasks still belong in
 * browser_run_task, where the observations stay inside this process. Both layers drive the
 * same browser through the same browser-actions module.
 *
 * This layer is not a bare pass-through. The emsn batch check (see checkEmsnShown) stays on
 * our side, because a host can only be *persuaded* by a tool description, whereas this is a
 * check in our code that it cannot get around.
 *
 * Tool names mirror the browser's own command names (Embiody.browserInputText ->
 * browser_input_text) so that a name maps one-to-one onto a browser capability and nothing
 * is lost in translation.
 */

/** Turn an ActionResult into an MCP tool result. */
function reply(result: ActionResult) {
  return {
    isError: !result.ok,
    content: [{ type: "text" as const, text: result.text }],
  };
}

function errorReply(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/**
 * The element numbers we showed the host, per tab and page.
 *
 * The kernel refuses a number whose element is gone, but not one it knows and never rendered
 * into annotatedContent: a host model that invents a plausible number gets a real click — how
 * a date picker was once clicked on the wrong day. Only we know what was shown.
 *
 * Numbers keep across the snapshots of a page and any snapshotId of the page is accepted with an
 * emsn (since October 2026), so a page's record is the union of its snapshots. Pages are kept, not
 * replaced: going back restores a cached page with its numbers and its old ids.
 */
const shownByTab = new Map<string, Map<string, Set<number>>>();
/** Pages remembered per tab, oldest dropped first; well past what the back cache holds. */
const PAGES_PER_TAB = 20;

/** The page part of "<page id>-<n>"; an id not of that shape stands for itself. */
function pageOf(snapshotId: string): string {
  return /^(.+)-\d+$/.exec(snapshotId)?.[1] ?? snapshotId;
}

function recordSnapshot(
  tabId: string,
  snapshotId: string,
  emsnLines: ReadonlyMap<string, string> | undefined,
): void {
  const page = pageOf(snapshotId);
  const pages = shownByTab.get(tabId) ?? new Map<string, Set<number>>();
  const emsns = pages.get(page) ?? new Set<number>();
  for (const key of emsnLines?.keys() ?? []) {
    const n = Number(key);
    if (Number.isFinite(n)) emsns.add(n);
  }
  // Re-inserted so the most recently seen page is the last to go.
  pages.delete(page);
  pages.set(page, emsns);
  if (pages.size > PAGES_PER_TAB) pages.delete(pages.keys().next().value!);
  shownByTab.set(tabId, pages);
}

/**
 * Refuse a number we never showed, before any input reaches the browser.
 *
 * A page we have no record of is left to the kernel: it refuses a snapshotId that is not of
 * the current page and names the one it holds, which beats anything we could say.
 */
function checkEmsnShown(
  tabId: string,
  snapshotId: string,
  emsn: number | undefined,
): string | null {
  if (emsn === undefined) return null;
  const emsns = shownByTab.get(tabId)?.get(pageOf(snapshotId));
  if (!emsns || emsns.has(emsn)) return null;
  return (
    `emsn ${emsn} was not in any snapshot you were shown of this page. ` +
    `The browser kernel may still know that number and would act on it, which is how a click ` +
    `silently lands on the wrong element. Pick a number that appears in a snapshot, ` +
    `or take a fresh browser_take_snapshot.`
  );
}

/**
 * Fill in windowId / tabId when the caller left them out.
 *
 * The kernel requires both. Making the host look the layout up before every action costs a
 * round trip per task, so default to the foreground tab of the frontmost window, and open a
 * window if there is none. When both are supplied, use them as given rather than guessing.
 */
async function resolveTarget(
  cdp: CdpClient,
  windowId?: string,
  tabId?: string,
): Promise<{ windowId: string; tabId: string; title?: string } | { error: string }> {
  if (windowId && tabId) return { windowId, tabId };

  let layout = await browserGetWindowInfo(cdp);
  if (layout.length === 0) {
    const created = await browserNewWindow(cdp, {});
    if (!created.ok) return { error: created.text };
    layout = await browserGetWindowInfo(cdp);
    if (layout.length === 0) {
      return { error: "No browser window is open and one could not be created." };
    }
  }

  let win: WindowInfo | undefined;
  // A tab named on its own belongs to whichever window holds it, not only the frontmost one.
  if (!windowId && tabId) {
    win = layout.find((w) => w.tabs.some((t) => t.tabId === tabId));
    if (!win) return { error: `Tab ${tabId} does not exist.` };
  } else if (windowId) {
    win = layout.find((w) => w.windowId === windowId);
    if (!win) return { error: `Window ${windowId} does not exist.` };
  } else {
    win = layout.find((w) => !w.isHidden) ?? layout[0];
  }

  const tab = tabId
    ? win.tabs.find((t) => t.tabId === tabId)
    : (win.tabs.find((t) => t.isForeground) ?? win.tabs[0]);
  if (!tab) {
    return {
      error: tabId
        ? `Tab ${tabId} is not in window ${win.windowId}.`
        : `Window ${win.windowId} has no tab to work with.`,
    };
  }
  return { windowId: win.windowId, tabId: tab.tabId, title: tab.title };
}

function isTargetError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/** A readable layout dump, so the host can see every window and tab with its id. */
function describeLayout(layout: WindowInfo[]): string {
  if (layout.length === 0) return "No browser window is open.";
  const lines: string[] = [];
  for (const w of layout) {
    const flags = [
      w.isHidden ? "hidden" : null,
      w.windowState !== "normal" ? w.windowState : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`window ${w.windowId}${flags ? ` (${flags})` : ""} — ${w.title}`);
    for (const t of w.tabs) {
      const marks = [
        t.isForeground ? "foreground" : null,
        t.canGoBack ? "can go back" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`  tab ${t.tabId}${marks ? ` (${marks})` : ""} — ${t.title} — ${t.url}`);
    }
  }
  return lines.join("\n");
}

/** One snapshot as the host reads it. */
function describeShot(shot: TabSnapshot, includeImage: boolean, format?: "text" | "json", links = false): string {
  const parts = [
    `windowId: ${shot.windowId}`,
    `tabId: ${shot.tabId}`,
    `snapshotId: ${shot.snapshotId}`,
    `url: ${shot.url}`,
    `title: ${shot.title}`,
  ];
  const kind = describePageType(shot.pageType);
  if (kind) parts.push(`pageType: ${shot.pageType} — ${kind}`);
  if (shot.loadingMessage) parts.push(`note: ${shot.loadingMessage}`);
  if (includeImage && shot.noImageReason) parts.push(`no image: ${shot.noImageReason}`);
  if (shot.popups.length > 0) {
    parts.push(`popups blocking this tab: ${JSON.stringify(shot.popups)}`);
  }
  if (format === "json") {
    parts.push("", shot.annotatedContent);
  } else {
    if (shot.position) parts.push(`page position: ${shot.position}`);
    parts.push("", links ? renderAnnotatedContent(shot.annotatedContent, { links: true }) : shot.rendered);
  }
  return parts.join("\n");
}

/** Pages per browser_read_pages: each page's text lands in the host's context. */
const READ_PAGES_MAX = 10;
const READ_PAGE_TIMEOUT_MS = 15_000;
/** Characters of each page per call; a long page runs to 150K, and the rest is a call away. */
const READ_PAGE_MAX_CHARS = 15_000;
/** The kernel's deadline for reading a whole page (87000px took 1.7-3.7s). */
const READ_PAGE_SNAPSHOT_MS = 20_000;

/**
 * Up to max characters of text from `from`, ending at a line break when the part has one and
 * never inside a footnote mark. next is where the following part starts; absent at the end.
 */
export function pageSlice(text: string, from: number, max: number): { part: string; next?: number } {
  const start = Math.min(Math.max(0, Math.floor(from)), text.length);
  const size = Math.max(1, Math.floor(max));
  if (text.length - start <= size) return { part: text.slice(start) };
  let end = text.lastIndexOf("\n", start + size);
  if (end <= start) {
    end = start + size;
    const mark = text.lastIndexOf("[^", end);
    if (mark > start && text.indexOf("]", mark) >= end) end = mark;
  }
  return { part: text.slice(start, end), next: text[end] === "\n" ? end + 1 : end };
}

/** One page read by browser_read_pages. */
function describeReadPage(p: {
  url: string;
  head: string;
  shot: TabSnapshot;
  title?: string;
  opened: ActionResult;
  deadline: number;
  from: number;
  maxChars: number;
}): string {
  const { shot, opened, deadline } = p;
  const lines = [p.head];
  if (shot.url && shot.url !== p.url) lines.push(`landed at: ${shot.url}`);
  if (p.title) lines.push(`title: ${p.title}`);
  const kind = describePageType(shot.pageType);
  if (kind) lines.push(`pageType: ${shot.pageType} — ${kind}`);
  const loadStatus = String(opened.data?.loadStatus ?? "");
  if (loadStatus !== "loaded") {
    lines.push(
      loadStatus === "failed"
        ? "note: the page did not load: a network error, or not a page at all (a download, a 204). What is read below is what the tab showed instead."
        : loadStatus === "timeout"
          ? `note: nothing had arrived after ${deadline} ms; what is read below is what the tab showed then.`
          : `note: read before the page finished loading (after ${deadline} ms it had reached ${loadStatus || "an unknown stage"})`,
    );
  }
  const { text, links } = renderWithLinks(shot.annotatedContent, { numbers: false, links: true });
  if (p.from >= text.length && p.from > 0) {
    lines.push(`from=${p.from} is past the end: the page has ${text.length} characters.`);
    return lines.join("\n");
  }
  const { part, next } = pageSlice(text, p.from, p.maxChars);
  if (p.from > 0) lines.push(`from character ${p.from} of ${text.length}`);
  lines.push("", part);
  // Each part lists the addresses of its own marks, so no part needs another.
  const used = footnotesIn(part);
  if (used.length > 0) lines.push("", footnoteList(links, used));
  if (next !== undefined) {
    lines.push("", `[${text.length - next} more characters: call again with from=${next} to read on]`);
  }
  return lines.join("\n");
}

/** The optional windowId / tabId of the tools that act on a tab. */
const TARGET = {
  windowId: z
    .string()
    .optional()
    .describe("Window to act on. Defaults to the frontmost window."),
  tabId: z
    .string()
    .optional()
    .describe("Tab to act on. Defaults to the foreground tab of that window."),
};

/** The id of the snapshot the numbers or coordinates were read from. */
const SNAPSHOT_ID = z
  .string()
  .describe(
    "The snapshotId from the browser_take_snapshot you picked the emsn out of. An element " +
      "keeps its emsn while the page stays (no navigation or reload), so with an emsn any " +
      "snapshot of the current page is accepted; with x,y only the latest one is. A number " +
      "whose element has gone is refused rather than clicked.",
  );

/** A tool's handler, kept so browser_batch can run the same code a single call runs. */
type Handler = (args: any) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;

/**
 * What browser_batch may chain: every tool that acts on the batch's one tab or its window.
 * Left out are the ones that change which tab is being acted on (new, select, close a tab or
 * a window), that hand the tab to a person (nothing but a snapshot works until it comes
 * back), and the ones with nothing to do inside a batch (the closing snapshot is taken
 * anyway; window info changes nothing).
 */
export const BATCHABLE = [
  "browser_click",
  "browser_input_text",
  "browser_press_key",
  "browser_select_editable_text",
  "browser_scroll",
  "browser_move",
  "browser_drag",
  "browser_wait",
  "browser_close_popup_bubble",
  "browser_navigate",
  "browser_go_back",
  "browser_go_forward",
  "browser_reload",
  "browser_stop_loading",
  "browser_set_audio_muted",
  "browser_show",
  "browser_minimize",
] as const;

/** Batch steps after which the snapshot's numbers no longer apply. */
const NAVIGATING = new Set<string>(["browser_navigate", "browser_go_back", "browser_go_forward", "browser_reload"]);

/** Whether a step names an element or a point from the snapshot. */
function aimsWithNumbers(args: Record<string, unknown> | undefined): boolean {
  return ["emsn", "toEmsn", "x"].some((k) => args?.[k] !== undefined);
}

function isMiddleClick(step: { tool: string; args?: Record<string, unknown> }): boolean {
  return step.tool === "browser_click" && step.args?.button === "middle";
}

/** The rest, each with why. A test holds every tool to one list or the other. */
export const NOT_BATCHABLE: Readonly<Record<string, string>> = {
  browser_new_tab: "changes which tab is acted on",
  browser_new_window: "changes which tab is acted on",
  browser_select_tab: "changes which tab is acted on",
  browser_close_tab: "the tab the later steps act on is gone",
  browser_close_window: "the tab the later steps act on is gone",
  browser_start_human_control: "only a snapshot works until the person hands it back",
  browser_stop_human_control: "pairs with start, which cannot be in a batch",
  browser_take_snapshot: "the batch takes one at the end anyway",
  browser_get_window_info: "changes nothing",
  browser_read_pages: "opens and closes tabs of its own",
  browser_batch: "no nesting",
};

export function registerThinBrowserTools(
  server: McpServer,
  cdp: CdpClient,
): void {
  // Record every handler and its argument schema as it is registered, so browser_batch reuses
  // the tools' own checks (the emsn batch check above all) instead of a second copy of them.
  const handlers = new Map<string, Handler>();
  const shapes = new Map<string, z.ZodRawShape>();
  const register = server.tool.bind(server) as (...a: unknown[]) => unknown;
  server = Object.create(server, {
    tool: {
      value: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler);
        const shape = a.length >= 4 ? a[a.length - 2] : undefined;
        if (shape && typeof shape === "object") shapes.set(a[0] as string, shape as z.ZodRawShape);
        return register(...a);
      },
    },
  }) as McpServer;
  void appendDebugLog("thin_tools", "registerTools", {});

  // ------------------------------------------------------------- Observing

  server.tool(
    "browser_take_snapshot",
    "Look at a tab: returns one line per element, the page position, the tab's URL and " +
      "title, any popups blocking it, and a snapshotId. Every actionable element carries a " +
      "number (emsn) at the start of its line — act on the number, never on pixel " +
      "coordinates. Take a fresh snapshot after anything that changes the page, to see what it " +
      "became: elements that appear have no number until then. Says so when the page is a PDF, " +
      "a browser error page or a crashed tab, each of which makes the obvious next move " +
      "useless. Give tabIds to look at several tabs in one call; each comes back with its own " +
      "snapshotId. Marks on a line: collapsed (in a closed section: open it first), modal (the " +
      "page outside it takes no clicks), hover-only (may do nothing on a click), also dblclick / " +
      "drag / ... (other listeners, perhaps only tracking; the list misses some: a list item " +
      "without drag may still drag, a spreadsheet cell without right_click may still take one: " +
      "try it and snapshot), options (a dropdown's choices), readonly (takes no typing; clicking it " +
      "often opens the page's picker), aria-readonly (the page says not to type, typing still goes in).",
    {
      ...TARGET,
      tabIds: z
        .array(z.string())
        .min(1)
        .max(MAX_SNAPSHOT_TABS)
        .optional()
        .describe("Several tabs at once, in any windows, instead of tabId."),
      includeImage: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Also return the annotated screenshot. Off by default because images are large; " +
            "turn it on when the page needs looking at (dates, layout, visual confirmation).",
        ),
      readWholePage: z
        .boolean()
        .optional()
        .describe(
          "Read the page around the screen too (about 8000px each way), not just the screen. " +
            "The image stays one screen; lines off it are marked offscreen and are still acted " +
            "on by emsn. Several times larger, so use it to search or read a " +
            "whole page, not on every look.",
        ),
      format: z
        .enum(["text", "json"])
        .optional()
        .describe(
          "text (default): one line per element, several times smaller. json: the browser's " +
            "raw annotatedContent tree, for tools that parse it themselves.",
        ),
      showLinks: z
        .boolean()
        .optional()
        .describe(
          "Mark each link with a footnote, [^3], and list the addresses after the elements. Turn " +
            "it on when you need addresses: to hand search results to browser_read_pages, or to " +
            "see where a link goes. A page may change a link on click; to be sure of the address, open it.",
        ),
      timeoutMs: z.number().optional().describe("How long to wait for the page to settle."),
    },
    async ({ windowId, tabId, tabIds, includeImage, readWholePage, showLinks, format, timeoutMs }) => {
      if (tabId && tabIds) return errorReply("Give tabId or tabIds, not both.");

      // The snapshot reply has no title; only the layout knows it. Missing a title is no reason to fail the snapshot.
      let targets: Array<{ windowId: string; tabId: string; title?: string }>;
      if (tabIds) {
        const layout = await browserGetWindowInfo(cdp).catch(() => [] as WindowInfo[]);
        targets = [];
        for (const id of new Set(tabIds)) {
          const win = layout.find((w) => w.tabs.some((t) => t.tabId === id));
          if (!win) return errorReply(`Tab ${id} does not exist.`);
          targets.push({ windowId: win.windowId, tabId: id, title: win.tabs.find((t) => t.tabId === id)?.title });
        }
      } else {
        const target = await resolveTarget(cdp, windowId, tabId);
        if (isTargetError(target)) return errorReply(target.error);
        const title =
          target.title ??
          (await browserGetWindowInfo(cdp).catch(() => []))
            .flatMap((w) => w.tabs)
            .find((t) => t.tabId === target.tabId)?.title;
        targets = [{ ...target, title }];
      }

      let batch;
      try {
        batch = await takeSnapshots(cdp, {
          targets: targets.map((t) => ({
            ...t,
            long: readWholePage,
            // A picture only when asked: in a minimized window one waits out the whole deadline.
            image: includeImage === true,
            href: showLinks === true,
          })),
          timeoutMs,
        });
      } catch (error) {
        return errorReply(
          `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];
      for (const t of targets) {
        const shot = batch.snapshots.find((s) => s.tabId === t.tabId);
        if (!shot) {
          const reason = batch.failures.find((f) => f.tabId === t.tabId)?.reason ?? "no snapshot came back";
          if (targets.length === 1) return errorReply(`Snapshot failed: ${reason}`);
          content.push({ type: "text", text: `tabId: ${t.tabId}\nsnapshot failed: ${reason}` });
          continue;
        }
        recordSnapshot(shot.tabId, shot.snapshotId, shot.emsnLines);
        content.push({ type: "text", text: describeShot(shot, includeImage, format, showLinks === true) });
        if (includeImage && shot.annotatedImage) {
          content.push({ type: "image", data: shot.annotatedImage, mimeType: "image/png" });
        }
      }
      return { isError: batch.snapshots.length === 0, content };
    },
  );

  server.tool(
    "browser_read_pages",
    "Read web pages; use it instead of a built-in fetch tool (WebFetch): it returns the page's " +
      "own text, not a summary, including pages built by scripts and sites the person is " +
      "signed in to. Each URL opens in a background tab of an existing " +
      "window, the whole page is read and the tab closed again, so nothing is left open. " +
      "Returns each page's text with no element numbers — to act on a page, open it with " +
      "browser_new_tab instead. Links are marked [^3], with the addresses after the text. " +
      `Each page gives up to ${READ_PAGE_MAX_CHARS} ` +
      "characters and says how to read on. One page failing does not fail the others. Not for " +
      "search results URLs: engines often answer those with a captcha, so search by typing " +
      "into the engine's own search box.",
    {
      urls: z
        .array(z.string())
        .min(1)
        .max(READ_PAGES_MAX)
        .describe(`The pages to read, up to ${READ_PAGES_MAX}; they load in parallel.`),
      windowId: z
        .string()
        .optional()
        .describe("Window to open the tabs in; defaults to the frontmost."),
      timeoutMs: z
        .number()
        .optional()
        .describe(
          `How long each page may take to load, default ${READ_PAGE_TIMEOUT_MS}. A page still ` +
            "loading then is read as it stands, and says so.",
        ),
      from: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Start each page's text at this character, to read on where a page said it stopped."),
      maxChars: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe(`Characters per page, default ${READ_PAGE_MAX_CHARS}.`),
    },
    async ({ urls, windowId, timeoutMs, from, maxChars }) => {
      const win = await resolveTarget(cdp, windowId, undefined);
      if (isTargetError(win)) return errorReply(win.error);
      const deadline = timeoutMs ?? READ_PAGE_TIMEOUT_MS;

      // TODO: put these tabs in a tab group of their own once the kernel has tab groups.
      const opened = await Promise.all(
        urls.map((url) =>
          browserAddNewTab(cdp, {
            windowId: win.windowId,
            url,
            foreground: false,
            waitUntil: "load",
            timeoutMs: deadline,
          }),
        ),
      );
      const tabIds = opened.map((r) => (r.data?.tabId ? String(r.data.tabId) : undefined));

      try {
        const targets = tabIds.flatMap((tabId) =>
          tabId ? [{ windowId: win.windowId, tabId, wholePage: true, href: true, image: false }] : [],
        );
        const batch =
          targets.length > 0
            ? await takeSnapshots(cdp, { targets, timeoutMs: READ_PAGE_SNAPSHOT_MS })
            : undefined;
        // The snapshot reply has no title; only the layout knows it.
        const titles = new Map(
          (await browserGetWindowInfo(cdp).catch(() => [] as WindowInfo[]))
            .flatMap((w) => w.tabs)
            .map((t) => [t.tabId, t.title]),
        );

        let read = 0;
        const blocks = urls.map((url, i) => {
          const head = `=== ${i + 1}/${urls.length} ${url}`;
          const tabId = tabIds[i];
          if (!tabId) return `${head}\nnot read: ${opened[i].text}`;
          const shot = batch?.snapshots.find((s) => s.tabId === tabId);
          if (!shot) {
            const reason = batch?.failures.find((f) => f.tabId === tabId)?.reason;
            return `${head}\nnot read: ${reason ?? "no snapshot came back"}`;
          }
          read++;
          return describeReadPage({
            url,
            head,
            shot,
            title: titles.get(tabId),
            opened: opened[i],
            deadline,
            from: from ?? 0,
            maxChars: maxChars ?? READ_PAGE_MAX_CHARS,
          });
        });

        return {
          isError: read === 0,
          content: [
            {
              type: "text" as const,
              text: [`Read ${read} of ${urls.length} pages; their tabs are closed again.`, ...blocks].join("\n\n"),
            },
          ],
        };
      } catch (error) {
        return errorReply(
          `Reading the pages failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await Promise.allSettled(
          tabIds.flatMap((tabId) =>
            tabId ? [browserCloseTab(cdp, { windowId: win.windowId, tabId })] : [],
          ),
        );
      }
    },
  );

  server.tool(
    "browser_get_window_info",
    "List every browser window and its tabs, with the windowId and tabId of each. Use it to " +
      "find out what is open; the other tools default to the frontmost window and tab, so you " +
      "usually do not need to call this first.",
    {},
    async () => {
      try {
        const layout = await browserGetWindowInfo(cdp);
        return { content: [{ type: "text" as const, text: describeLayout(layout) }] };
      } catch (error) {
        return errorReply(
          `Reading the window layout failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // ---------------------------------------------------------------- Input

  server.tool(
    "browser_click",
    "Click an element by its number (emsn) from the latest snapshot. The kernel asks the page " +
      "where that element is right now and refuses if it has gone, moved out of reach, or is " +
      "covered by something else — it does not pretend to succeed. Passing x/y instead skips " +
      "all of that checking, so prefer emsn.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      emsn: z.number().optional().describe("Element number from the snapshot."),
      x: z.number().optional().describe("Fallback pixel X; only when no emsn fits."),
      y: z.number().optional().describe("Fallback pixel Y; only when no emsn fits."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left."),
      clickCount: z.number().optional().describe("2 for a double click."),
    },
    async ({ windowId, tabId, snapshotId, emsn, x, y, button, clickCount }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
      if (shown) return errorReply(shown);
      return reply(
        await browserClick(cdp, {
          ...target,
          snapshotId,
          emsn,
          x,
          y,
          button,
          clickCount,
        }),
      );
    },
  );

  server.tool(
    "browser_input_text",
    "Type text into an element by its number (emsn), or into whatever has focus when no emsn " +
      "is given. Fails, typing nothing, when the field does not take focus. Also sets a " +
      "dropdown (SELECT, or its label): text is the option exactly as listed in its options; " +
      "and a date (YYYY-MM-DD), time (HH:MM), date and time (YYYY-MM-DDTHH:MM), month (YYYY-MM), " +
      "week (YYYY-Www) or colour (#rrggbb) field, " +
      "without opening a picker. Use this rather than clicking a SELECT: its list is not in " +
      "snapshots.\n" +
      "To edit a text field or editable area (a mail body, a rich-text editor) in the middle, give " +
      "one of before / after / replace / at with its emsn. Copy the words from its snapshot value " +
      "as they are written there: \\n for a line break, ¤ escapes kept; ‸ (the caret) and ⟦⟧ (the " +
      "selection) are ignored. Not found, or found in several places without occurrence: nothing " +
      "is typed and the places are listed. The text is read back afterwards and the reply quotes " +
      "the changed lines; if they differ (the editor reformatted it), it fails saying the text was " +
      "typed. Without these, text goes in at the caret; the element is clicked first unless focus is already in it.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      text: z.string().describe("The text to type, as it is; empty with replace deletes."),
      emsn: z.number().optional().describe("Element number to type into."),
      clearText: z
        .boolean()
        .optional()
        .describe("Clear the field first instead of appending. Not with a place: it clears a whole mail body, quote and signature too."),
      pressEnter: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, as a person does: it submits a form, and adds a line in a multi-line box."),
      before: z.string().optional().describe("Type just before these words."),
      after: z.string().optional().describe("Type just after these words."),
      replace: z.string().optional().describe("Replace these words with text."),
      at: z.enum(["start", "end"]).optional().describe("Type at the start or end of the element's text."),
      occurrence: z
        .number()
        .optional()
        .describe("Which place, from 1, when the words are in several; overlaps count."),
    },
    async ({ windowId, tabId, snapshotId, text, emsn, clearText, pressEnter, before, after, replace, at, occurrence }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
      if (shown) return errorReply(shown);
      return reply(
        await browserInputText(cdp, {
          ...target,
          snapshotId,
          text,
          emsn,
          clearText,
          pressEnter,
          before,
          after,
          replace,
          at,
          occurrence,
        }),
      );
    },
  );

  server.tool(
    "browser_press_key",
    "Press keys, in order, where focus is: Escape closes a dialog on the page, Tab moves to the next field, " +
      "ArrowDown/Enter pick from a suggestion list, End or arrows move the caret before " +
      "browser_input_text without emsn types there, Control+Z undoes. Not for typing text. Refused, " +
      "nothing pressed: copy/cut/paste, and the browser's own shortcuts (use browser_close_tab, " +
      "browser_reload and so on). Replies once the page has handled the last key; it does not " +
      "say what the keys did, so snapshot to see. A list highlighted under the pointer counts " +
      "arrows from that item, which a snapshot does not show: to pick a given item, click it.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      keys: z
        .array(
          z.object({
            key: z
              .string()
              .describe(
                'An event.key name, modifiers joined with "+": "Escape", "Enter", "Tab", "Shift+Tab", ' +
                  '"ArrowDown", "Home", "End", "Backspace", "Delete", "Control+A", "Control+Z", or one ASCII character.',
              ),
            repeatCount: z.number().optional().describe("Times in a row; default 1."),
          }),
        )
        .describe("At most 100 presses in all."),
      emsn: z
        .number()
        .optional()
        .describe(
          "Focus this element first: clicked unless focus is already in it, so a button or link " +
            "acts and a field's caret moves to the click. Leave out to press where focus is.",
        ),
      repeatDelayMs: z.number().optional().describe("Pause between presses, default 80."),
    },
    async ({ windowId, tabId, snapshotId, keys, emsn, repeatDelayMs }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
      if (shown) return errorReply(shown);
      return reply(await browserPressKey(cdp, { ...target, snapshotId, keys, emsn, repeatDelayMs }));
    },
  );

  server.tool(
    "browser_select_editable_text",
    "Select words in a text field or editable area (a mail body, a rich-text editor), as a person " +
      "drags over them, so a toolbar button (bold, colour, link) acts on them next: a click on it " +
      "can follow in the same batch. Nothing else changes, except that a click giving it focus stays. " +
      "Give one of select, from with to, or all. " +
      "Copy the words from the element's snapshot value as for browser_input_text's before/after. " +
      "The reply quotes the lines the selection is on, marked ⟦…⟧. Refused, nothing selected: not " +
      "found, or in several places without occurrence (the places are listed); an end inside a " +
      "picture, a list number or an @mention; across table cells where the editor keeps a selection " +
      "in one cell (select cell by cell); over a picture with its own editable caption (click the " +
      "picture instead); a password, read-only or disabled field.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      emsn: z.number().describe("The field or editable area, from the snapshot."),
      select: z.string().optional().describe("Select these words."),
      from: z.string().optional().describe("Select from these words through those of to, both included."),
      to: z.string().optional().describe("Where a from selection ends: the first place after from."),
      all: z.boolean().optional().describe("All of the element's text (not the page). To select only your own part of a rich editor, use from/to."),
      occurrence: z
        .number()
        .optional()
        .describe("Which place, from 1, of select's or from's words when they are in several; overlaps count."),
      toOccurrence: z.number().optional().describe("Which place of to's words after from, from 1."),
    },
    async ({ windowId, tabId, snapshotId, emsn, select, from, to, all, occurrence, toOccurrence }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
      if (shown) return errorReply(shown);
      return reply(
        await browserSelectEditableText(cdp, { ...target, snapshotId, emsn, select, from, to, all, occurrence, toOccurrence }),
      );
    },
  );

  server.tool(
    "browser_scroll",
    "Scroll. Give deltaY (how far; positive is down, as scrollTop counts) or toY (where to end " +
      "up; 0 is the top, 999999 the bottom), not both; deltaX / toX are the horizontal ones. " +
      "What scrolls is whatever is under the pointer: to scroll a pane that scrolls on its own " +
      "(a mail list, a results panel), give its emsn; emsn -1 scrolls the whole page, only when " +
      "the snapshot's page position line offers it. Replies once the scroll is at rest, saying " +
      "when it moved less than asked (at the end, or the page took the wheel); coordinates are " +
      "void after a scroll, so take a fresh snapshot to see where you are.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID.optional().describe("Required with emsn or x,y; see browser_click."),
      deltaX: z.number().optional().describe("Horizontal pixels; positive scrolls right."),
      deltaY: z.number().optional().describe("Vertical pixels; positive scrolls down."),
      toX: z.number().optional().describe("Horizontal offset to end up at."),
      toY: z.number().optional().describe("Vertical offset to end up at; past the end is the end."),
      emsn: z.number().optional().describe("The scrollable element to scroll, from the snapshot; -1 for the page."),
      x: z.number().optional().describe("With y, a viewport point to scroll at instead of an emsn; with an emsn, a spot inside it."),
      y: z.number().optional().describe("See x."),
      repeatCount: z.number().optional().describe("Repeat a deltaY/deltaX scroll this many times."),
      repeatDelayMs: z.number().optional().describe("Pause between repeats, default 300."),
      speed: z.number().optional().describe("Percent of human hand speed, default 100. Changes duration, not distance."),
      timeoutMs: z.number().optional().describe("How long it may take to come to rest or arrive; default 7000, more with repeatCount."),
    },
    async ({ windowId, tabId, snapshotId, emsn, x, y, ...rest }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      if (snapshotId && emsn !== -1) {
        const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
        if (shown) return errorReply(shown);
      }
      return reply(
        await browserScroll(cdp, { ...target, ...rest, snapshotId, onEmsn: emsn, onX: x, onY: y }),
      );
    },
  );

  server.tool(
    "browser_move",
    "Hover the pointer over an element, for a menu or a tooltip that only appears under it. " +
      "Whatever appears is not numbered until you take a fresh snapshot, so hover first, then " +
      "snapshot, then act. The reply says where the pointer ended up.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      emsn: z.number().optional().describe("Element to hover, from the snapshot."),
      x: z
        .number()
        .optional()
        .describe("With an emsn, a spot inside that element; on its own, a viewport point."),
      y: z.number().optional().describe("See x."),
    },
    async ({ windowId, tabId, snapshotId, emsn, x, y }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const shown = checkEmsnShown(target.tabId, snapshotId, emsn);
      if (shown) return errorReply(shown);
      return reply(await browserMove(cdp, { ...target, snapshotId, emsn, x, y }));
    },
  );

  server.tool(
    "browser_drag",
    "Press on something, carry it somewhere, let go. The one gesture a click cannot make, so " +
      "this is for sliders, panning a canvas, split bars and lists that reorder. Give the " +
      "destination exactly one way: toEmsn (with toX and toY for a spot inside it), or toX and " +
      "toY, or dx and dy. **Both ends must " +
      "already be on screen** — the far end is not scrolled into view, so scroll first.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID,
      emsn: z.number().optional().describe("Element to press on."),
      x: z
        .number()
        .optional()
        .describe("With an emsn, a spot inside it; on its own, the point to press."),
      y: z.number().optional().describe("See x."),
      toEmsn: z.number().optional().describe("Element to release over."),
      toX: z.number().optional().describe("Point to release at; needs toY."),
      toY: z.number().optional().describe("See toX."),
      dx: z.number().optional().describe("Release this far from the press, horizontally."),
      dy: z.number().optional().describe("See dx."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left."),
      holdMs: z
        .number()
        .optional()
        .describe("How long to hold before moving. Raise it for a list that needs a long press."),
      settleMs: z
        .number()
        .optional()
        .describe("How long to rest at the far end before releasing."),
    },
    async ({ windowId, tabId, snapshotId, emsn, toEmsn, ...rest }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      for (const n of [emsn, toEmsn]) {
        const shown = checkEmsnShown(target.tabId, snapshotId, n);
        if (shown) return errorReply(shown);
      }
      return reply(
        await browserDrag(cdp, { ...target, snapshotId, emsn, toEmsn, ...rest }),
      );
    },
  );

  server.tool(
    "browser_wait",
    "Wait before looking again, for pages that are still settling. Clamped to 100–10000 ms.",
    { durationMs: z.number().optional().describe("Milliseconds to wait; default 2000.") },
    async ({ durationMs }) => reply(await browserWait(cdp, { durationMs })),
  );

  // ----------------------------------------------------------- Navigation

  server.tool(
    "browser_navigate",
    "Open a URL in a tab. Element numbers from before the navigation are void afterwards.",
    {
      ...TARGET,
      url: z.string().describe("The URL to open."),
      waitUntil: z
        .string()
        .optional()
        .describe("How far to wait for loading: commit, title, firstPaint or load."),
      timeoutMs: z.number().optional().describe("How long to wait for the load."),
    },
    async ({ windowId, tabId, url, waitUntil, timeoutMs }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(
        await browserNavigate(cdp, { ...target, url, waitUntil, timeoutMs }),
      );
    },
  );

  server.tool(
    "browser_go_back",
    "Go back one step in this tab's history. browser_get_window_info reports whether a tab " +
      "can go back; calling this when it cannot will fail.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserGoBack(cdp, target));
    },
  );

  server.tool(
    "browser_go_forward",
    "Go forward one step in this tab's history.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserGoForward(cdp, target));
    },
  );

  server.tool(
    "browser_reload",
    "Reload the tab. Element numbers from before the reload are void afterwards.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserReload(cdp, target));
    },
  );

  server.tool(
    "browser_stop_loading",
    "Stop the page loading in this tab, like the browser's stop button. This is about page " +
      "loading only. To stop a running browser_run_task, use browser_stop_task.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserStopLoading(cdp, target));
    },
  );

  // ------------------------------------------------------ Tabs and windows

  server.tool(
    "browser_new_tab",
    "Open a new tab. Returns the new tabId.",
    {
      url: z.string().optional().describe("URL to open; defaults to a blank tab."),
      windowId: z
        .string()
        .optional()
        .describe("Window to open it in; defaults to the frontmost."),
      foreground: z.boolean().optional().describe("Bring the new tab to the front."),
      waitUntil: z.string().optional().describe("How far to wait for loading."),
      timeoutMs: z.number().optional().describe("How long to wait for the load."),
    },
    async ({ windowId, ...rest }) => {
      const target = await resolveTarget(cdp, windowId, undefined);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(
        await browserAddNewTab(cdp, { windowId: target.windowId, ...rest }),
      );
    },
  );

  server.tool(
    "browser_select_tab",
    "Bring a tab to the front of its window.",
    {
      windowId: z.string().describe("The tab's window."),
      tabId: z.string().describe("The tab to bring forward."),
    },
    async ({ windowId, tabId }) => {
      // browserSelectTab returns void and signals failure by throwing.
      try {
        await browserSelectTab(cdp, { windowId, tabId });
      } catch (error) {
        return errorReply(
          `Selecting the tab failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return {
        content: [{ type: "text" as const, text: `Tab ${tabId} is now in front.` }],
      };
    },
  );

  server.tool(
    "browser_close_tab",
    "Close a tab.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      shownByTab.delete(target.tabId);
      return reply(await browserCloseTab(cdp, target));
    },
  );

  server.tool(
    "browser_new_window",
    "Open a new browser window. Returns the new windowId.",
    {
      url: z.string().optional().describe("URL to open in the first tab."),
      hideWindow: z.boolean().optional().describe("Keep the window off screen."),
      incognito: z.boolean().optional().describe("Open an incognito window."),
    },
    async (params) => reply(await browserNewWindow(cdp, params)),
  );

  server.tool(
    "browser_close_window",
    "Close a browser window and every tab in it. Other windows are unaffected. To close a " +
      "single tab use browser_close_tab.",
    { windowId: z.string().describe("The window to close.") },
    async ({ windowId }) => reply(await browserCloseWindow(cdp, { windowId })),
  );

  server.tool(
    "browser_show",
    "Bring a window on screen. Windows driven by an agent are often hidden or off screen, so " +
      "show one before asking a person to look at it.",
    {
      windowId: z.string().describe("The window to show."),
      toState: z.enum(["Restore", "Maximized"]).optional().describe("Default Restore."),
    },
    async ({ windowId, toState }) => {
      // browserShow returns void and signals failure by throwing.
      try {
        await browserShow(cdp, { windowId, toState });
      } catch (error) {
        return errorReply(
          `Showing the window failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return {
        content: [{ type: "text" as const, text: `Window ${windowId} is on screen.` }],
      };
    },
  );

  server.tool(
    "browser_minimize",
    "Minimize one of your windows (every tab in it yours), to keep it out of a person's way while you work in it. Pages in it " +
      "keep running at full speed and snapshots keep working. browser_show brings it back.",
    {
      windowId: z.string().describe("The window to minimize."),
    },
    async ({ windowId }) => reply(await browserMinimize(cdp, { windowId })),
  );

  server.tool(
    "browser_set_audio_muted",
    "Mute or unmute a tab.",
    { ...TARGET, muted: z.boolean().describe("true to mute.") },
    async ({ windowId, tabId, muted }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserSetAudioMuted(cdp, { ...target, muted }));
    },
  );

  // ------------------------------------------- Popups and human handover

  server.tool(
    "browser_close_popup_bubble",
    "Answer the popup blocking a tab (permission bubbles, dialogs). browser_take_snapshot " +
      "reports which popups are open and what each one accepts. When unsure use dismiss: it " +
      "refuses without writing a decision into the browser profile, where it would outlive " +
      "the task.",
    {
      ...TARGET,
      action: z
        .enum(["allowOnce", "allow", "deny", "dismiss", "ignore"])
        .optional()
        .describe("Default dismiss, the most conservative one."),
    },
    async ({ windowId, tabId, action }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserClosePopupBubble(cdp, { ...target, action }));
    },
  );

  server.tool(
    "browser_batch",
    "Run several page actions on one tab in a row, all aimed with the numbers of one " +
      "snapshot, then get a fresh snapshot back — one call instead of one per step. Use it " +
      "for steps that do not depend on each other's result: tick two filters, fill three " +
      "fields that are already on screen. Do not put a step in that aims at something an " +
      "earlier step makes appear (a suggestion list, a menu): its number does not exist yet. " +
      "Stops at the first failure; after a step the browser says changed the page, the later steps " +
      "that aim by number are skipped. Worth " +
      "using for a single action too: the snapshot comes back in the same call.",
    {
      ...TARGET,
      snapshotId: SNAPSHOT_ID.optional().describe("From the snapshot the numbers were read from; required when any step names an emsn (a step may carry its own in args instead)."),
      actions: z
        .array(
          z.object({
            tool: z.enum(BATCHABLE, {
              errorMap: () => ({ message: `each step is {"tool": "browser_click", "args": {"emsn": 9}}; tool is one of ${BATCHABLE.join(", ")}` }),
            }),
            args: z.record(z.string(), z.any()).optional().describe("That tool's own arguments, without windowId/tabId."),
          }),
        )
        .min(1)
        .max(10),
    },
    async ({ windowId, tabId, snapshotId, actions }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      const lines: string[] = [];
      let failed = false;
      for (const [i, step] of actions.entries()) {
        const run = handlers.get(step.tool)!;
        // Held to the tool's own schema as a single call is: unknown fields stripped (the
        // kernel refuses a name it does not take), types and ranges checked.
        let args: Record<string, unknown> = step.args ?? {};
        const stepSnapshotId = typeof args.snapshotId === "string" && args.snapshotId.trim() ? args.snapshotId : snapshotId;
        const shape = shapes.get(step.tool);
        if (shape) {
          const { windowId: _w, tabId: _t, snapshotId: _s, ...own } = shape;
          const parsed = z.object(own).safeParse(args);
          if (!parsed.success) {
            const why = parsed.error.issues.map((e) => `${e.path.join(".") || "args"}: ${e.message}`).join("; ");
            lines.push(`${i + 1}. ${step.tool} FAILED: invalid arguments (${why})`);
            failed = true;
            break;
          }
          args = parsed.data;
        }
        const res = await run({ ...args, ...target, snapshotId: stepSnapshotId });
        const text = res.content.map((c) => c.text ?? "").join(" ");
        lines.push(`${i + 1}. ${step.tool}${res.isError ? " FAILED" : ""}: ${text}`);
        if (res.isError) {
          failed = true;
          break;
        }
        // Past a change the browser reports or a navigation, the remaining steps were planned on
        // a page that is gone. Steps that use no numbers (a wait, a scroll to the top) still run.
        const rest = actions.slice(i + 1).filter((s) => aimsWithNumbers(s.args));
        const aiming = rest.length > 0;
        // A run of middle clicks goes on: each opens a link elsewhere and leaves this page alone
        // (the change reported is the link scrolled into view); a stray one costs a background tab.
        const onlyOpeningLinks = isMiddleClick(step) && rest.every(isMiddleClick);
        if (aiming && !onlyOpeningLinks && /page has changed/i.test(text)) {
          lines.push(`Stopped after step ${i + 1}: the page changed, so the remaining steps, which aim with this snapshot's numbers, were not run.`);
          break;
        }
        if (aiming && NAVIGATING.has(step.tool)) {
          lines.push(`Stopped after step ${i + 1}: the page navigated, so the numbers the remaining steps use no longer apply. Read them off the snapshot below.`);
          break;
        }
      }
      const shot = await handlers.get("browser_take_snapshot")!({ ...target });
      return {
        isError: failed,
        content: [
          { type: "text" as const, text: lines.join("\n") },
          ...shot.content.map((c) => ({ type: "text" as const, text: c.text ?? "" })),
        ],
      };
    },
  );

  server.tool(
    "browser_start_human_control",
    "Hand the tab to a person so they can use the real keyboard and mouse on it. Required for " +
      "anything only a person can do — a password, a code sent to them, a captcha, proving who " +
      "they are — because while the agent drives the tab their physical input does not reach " +
      "the page at all. The window is brought on screen. While the person has it, every " +
      "command on that tab fails except browser_take_snapshot, which is how you tell when they " +
      "are done. Call browser_stop_human_control to resume.",
    {
      ...TARGET,
      showWindow: z
        .boolean()
        .optional()
        .describe("Bring the window on screen. Default true; leave it on."),
    },
    async ({ windowId, tabId, showWindow }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserStartHumanControl(cdp, { ...target, showWindow }));
    },
  );

  server.tool(
    "browser_stop_human_control",
    "Take the tab back and resume automating it. A handover the agent started can be ended " +
      "freely; if the person took the tab over themselves, they are asked first and may refuse.",
    { ...TARGET },
    async ({ windowId, tabId }) => {
      const target = await resolveTarget(cdp, windowId, tabId);
      if (isTargetError(target)) return errorReply(target.error);
      return reply(await browserStopHumanControl(cdp, target));
    },
  );
}
