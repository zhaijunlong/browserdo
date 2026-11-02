import fs from "node:fs";
import path from "node:path";
import {
  collectEmsnLines,
  renderAnnotatedContent,
  renderPagePosition,
} from "./annotated_content.js";
import { CdpClient } from "./cdp-client.js";
import {
  PopupInfo,
  TabInfo,
  TabSnapshot,
  TabSnapshotFailure,
  WindowInfo,
} from "./runtime_types.js";
import {
  CDP_COMMAND_TIMEOUT_MS,
  SAVE_SNAPSHOTS,
  SNAPSHOT_DIR,
  SNAPSHOT_RETURN_IMAGE,
  SNAPSHOT_TIMEOUT_MS,
} from "./config.js";
import { appendDebugLog } from "./logger.js";

/**
 * The fine-grained action layer: one ordinary async function per action — validate, call CDP,
 * return a structured result. Action names carry a browser prefix so the model can see at a
 * glance what they touch.
 *
 * Follows embiody_protocol.pdl. Two things bite:
 * - windowId/tabId are required wherever the pdl lists them; missing ones are refused here
 *   rather than sent out in exchange for an InvalidParams.
 * - Navigation replies have no success field; success is read from loadStatus alone.
 * The commands the pdl marks "Not implemented" (freezeRender, manageCookies, waitForElement,
 * ...) are not wrapped.
 */

export type { TabInfo, WindowInfo };

/** The common result shape for actions. ok=false means the kernel refused it or the parameters were invalid. */
export interface ActionResult {
  ok: boolean;
  text: string;
  /** May carry structured extras such as a new window/tab id or the landed url, for the runtime to update its working target. */
  data?: Record<string, unknown>;
}

/** The reply shape shared by the navigation commands (browserNavigate/GoBack/GoForward/Reload/NewTab). */
interface NavigationReply {
  windowId?: string;
  tabId?: string;
  title?: string;
  url?: string;
  loadStatus?: string;
}

function resultError(result: any, fallback: string): string {
  return result?.error || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * When the command succeeded but the page shifted under its feet, the kernel attaches a
 * message (the element moved, or was scrolled into view) and suggests snapshotting again.
 * It must reach the model verbatim: the action took effect, but the snapshot it holds is stale.
 */
function withKernelMessage(text: string, result: any): string {
  const message =
    typeof result?.message === "string" ? result.message.trim() : "";
  return message ? `${text}; kernel note: ${message}` : text;
}

/**
 * The "frame never took focus" timeout of browserInputText and browserPressKey: the kernel
 * says nothing was typed or pressed and to retry. The other errors (a dead emsn, obscured,
 * cannot be scrolled into view) need a fresh snapshot instead.
 */
function isRetryableFocusTimeout(message: string): boolean {
  return /did not take input focus|focus did not reach the element's frame/i.test(message);
}

/** Send a keyboard command, once more after a focus timeout. */
async function sendRetryingFocus(
  cdp: CdpClient,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ result?: any; error?: string }> {
  const send = async (): Promise<{ result?: any; error?: string }> => {
    try {
      return { result: await cdp.sendCommand(method, payload) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };
  const attempt = await send();
  if (!attempt.error || !isRetryableFocusTimeout(attempt.error)) return attempt;
  await appendDebugLog("browser_actions", "focus timed out, retrying once", { method, error: attempt.error });
  return send();
}

/**
 * windowId/tabId are already required by the kernel. When missing we must not let JSON
 * serialisation quietly drop the field — that only buys an InvalidParams; refuse at this
 * layer instead, with an error saying which action is missing what.
 */
function requireTarget(
  action: string,
  params: { windowId?: string; tabId?: string },
): { windowId: string; tabId: string } | { error: string } {
  const windowId = (params.windowId ?? "").trim();
  const tabId = (params.tabId ?? "").trim();
  const missing: string[] = [];
  if (!windowId) missing.push("windowId");
  if (!tabId) missing.push("tabId");
  if (missing.length) {
    return { error: `${action} is missing required parameter ${missing.join("/")} (the kernel no longer accepts omitting it)` };
  }
  return { windowId, tabId };
}

function requireWindow(
  action: string,
  windowId?: string,
): { windowId: string } | { error: string } {
  const id = (windowId ?? "").trim();
  if (!id) {
    return { error: `${action} is missing required parameter windowId (the kernel no longer accepts omitting it)` };
  }
  return { windowId: id };
}

/**
 * Read an id out of a kernel reply. Missing or blank always returns undefined and **never the
 * string "undefined"** — a fake id like that gets written in as a valid working target, after
 * which every command reports "No Tab found" and the real cause (the kernel gave no id) is
 * nowhere to be seen.
 */
function readId(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function isTargetError(
  value: { error: string } | Record<string, unknown>,
): value is { error: string } {
  return typeof (value as { error?: unknown }).error === "string";
}

/**
 * Get the snapshot id this operation must carry.
 *
 * The kernel made it required and validates it, and the pdl says why in so many words: a
 * number from the previous batch does not point at a nonexistent element, it points at **a
 * different** element. So without it the call must not be sent — it would either be refused
 * with InvalidParams or, worse, really click something else on an older kernel.
 *
 * The wording is for an outside agent; browser_run_task rewrites it into its own terms
 * (see isMissingSnapshotId).
 */
function requireSnapshotId(
  action: string,
  snapshotId: string | undefined,
  tabId: string | undefined,
): { snapshotId: string } | { error: string } {
  const id = (snapshotId ?? "").trim();
  if (id) return { snapshotId: id };
  return {
    error: `${MISSING_SNAPSHOT_ID} for ${action} on tab ${tabId || "?"}. Take a snapshot of this tab with browser_take_snapshot and pass the snapshotId it returns`,
  };
}

const MISSING_SNAPSHOT_ID = "No snapshotId";

export function isMissingSnapshotId(text: string): boolean {
  return text.startsWith(MISSING_SNAPSHOT_ID);
}

/**
 * The wait milestones accepted on the request side. Note the spellings differ from the
 * loadStatus of the reply side (request commit/title/load vs reply committed/titled/loaded);
 * the two must not be mixed.
 */
const WAIT_UNTIL_VALUES = new Set(["commit", "title", "firstPaint", "load"]);

/**
 * Put only defined, valid wait parameters into the payload and leave the rest to the kernel's
 * defaults (waitUntil=title, timeoutMs=10000). An invalid value is better dropped in favour of
 * the default than sent out in exchange for an InvalidParams.
 */
function withWaitParams(
  payload: Record<string, unknown>,
  params: { waitUntil?: string; timeoutMs?: number },
): Record<string, unknown> {
  if (params.waitUntil && WAIT_UNTIL_VALUES.has(params.waitUntil)) {
    payload.waitUntil = params.waitUntil;
  }
  if (
    params.timeoutMs !== undefined &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
  ) {
    payload.timeoutMs = params.timeoutMs;
  }
  return payload;
}

/**
 * The arrival milestones. **A whitelist**: only the values listed here count as "arrived".
 *
 * Why a whitelist rather than "exclude the known failure states": that is exactly the shape of
 * the old `success` bug. If the kernel later adds a new failure value, exclusion silently
 * treats it as success and the model reasons on from there. In the same situation a whitelist
 * merely asks once more, which is the safe direction.
 */
const ARRIVED_LOAD_STATUSES = new Set([
  "committed",
  "titled",
  "firstPaint",
  "loaded",
]);

/**
 * Interpret a navigation reply. These commands have **no success field** in their returns, and
 * success is read from loadStatus alone:
 *   committed/titled/firstPaint/loaded -- arrived (arriving shallower than asked is not an error)
 *   failed   -- did not land on the target page (a network error, or a response that does not
 *               navigate at all: a download, a 204)
 *   timeout  -- nothing committed before the deadline; where it landed is unknown
 *   formResubmission -- only browserReload gives this: the page was reached by submitting a
 *               form, and nothing happened
 *   anything else -- the kernel added a value we do not know yet; treated as "cannot
 *               interpret" (see the whitelist comment)
 */
function describeNavigation(
  intent: string,
  reply: NavigationReply,
  fallbackTarget: { windowId?: string; tabId?: string },
): ActionResult {
  const loadStatus = String(reply?.loadStatus ?? "");
  const url = reply?.url ? String(reply.url) : "";
  const title = reply?.title ? String(reply.title) : "";
  const data = {
    windowId: reply?.windowId ? String(reply.windowId) : fallbackTarget.windowId,
    tabId: reply?.tabId ? String(reply.tabId) : fallbackTarget.tabId,
    url,
    title,
    loadStatus,
  };

  if (loadStatus === "failed") {
    return {
      ok: false,
      text: `${intent} failed (loadStatus=failed): it did not land on the target page. Either a network error, or the response is not a navigable page at all (a download, a 204). Currently sitting at ${url || "an unknown address"}`,
      data,
    };
  }
  if (loadStatus === "timeout") {
    return {
      ok: false,
      text: `${intent} timed out (loadStatus=timeout): nothing committed before the deadline and where it stopped is unknown. Next round you must confirm the real page state from a fresh snapshot`,
      data,
    };
  }
  if (loadStatus === "formResubmission") {
    return {
      ok: false,
      text: `${intent} was not performed (loadStatus=formResubmission): this page was reached by submitting a form, and reloading would send it again (possibly a second order, a second charge), so the kernel did nothing and the tab is unchanged. If you are sure resubmitting here is safe, call again with resubmitForm=true; if not, take another route with browserNavigate`,
      data,
    };
  }
  if (!loadStatus) {
    return {
      ok: false,
      text: `${intent} gave an unreadable result: the kernel reply carries no loadStatus (${JSON.stringify(reply).slice(0, 200)})`,
      data,
    };
  }
  if (!ARRIVED_LOAD_STATUSES.has(loadStatus)) {
    return {
      ok: false,
      text: `${intent} gave an unreadable result: the kernel returned loadStatus=${loadStatus}, which this project does not recognise, so whether it arrived cannot be decided. Go by the next screenshot and do not assume success`,
      data,
    };
  }

  // committed / titled / firstPaint / loaded: arrived. The landed url comes from the reply —
  // after a redirect the requested url and the actual landing place are different things, and
  // the model must see the real one.
  return {
    ok: true,
    text: `${intent} done (loadStatus=${loadStatus}): landed at ${url || "unknown"}${title ? ` (${title})` : ""}`,
    data,
  };
}

/** List every window and tab (wrapping Embiody.browserGetWindowInfo). */
export async function browserGetWindowInfo(
  cdp: CdpClient,
): Promise<WindowInfo[]> {
  const result: any = await cdp.sendCommand("Embiody.browserGetWindowInfo", {});
  if (result?.success === false) {
    throw new Error(
      `browserGetWindowInfo failed: ${resultError(result, "unknown error")}`,
    );
  }
  const windows = Array.isArray(result?.windows) ? result.windows : [];
  return windows.map((win: any): WindowInfo => ({
    windowId: String(win?.windowId ?? ""),
    index: Number(win?.index ?? 0),
    title: String(win?.title ?? ""),
    isHidden: !!win?.isHidden,
    windowState: String(win?.windowState ?? ""),
    // The protocol calls an agent tab a "ghost" tab.
    hasAgentTab: !!win?.hasGhostTab,
    tabs: (Array.isArray(win?.tabs) ? win.tabs : []).map(
      (tab: any): TabInfo => ({
        tabId: String(tab?.tabId ?? ""),
        index: Number(tab?.index ?? 0),
        title: String(tab?.title ?? ""),
        url: String(tab?.url ?? ""),
        isForeground: !!tab?.isForeground,
        isAgentTab: !!tab?.isGhost,
        canGoBack: !!tab?.canGoBack,
        canGoForward: !!tab?.canGoForward,
        isMuted: !!tab?.isMuted,
        isAudible: !!tab?.isAudible,
      }),
    ),
  }));
}

/** Parse the popup list a snapshot brought back. Missing or misshapen always means "no popups"; nothing is invented. */
function readPopups(raw: unknown): PopupInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      type: String(p.type ?? ""),
      message:
        typeof p.message === "string" && p.message ? p.message : undefined,
      title: typeof p.title === "string" && p.title ? p.title : undefined,
      availableActions: Array.isArray(p.availableActions)
        ? p.availableActions.map((a) => String(a))
        : [],
    }))
    .filter((p) => p.type);
}

/**
 * The actions browserClosePopupBubble accepts. They are not synonyms:
 *   allowOnce  granted for this session only, not written to the profile
 *   allow      granted **and persisted**, outliving this task
 *   deny       refused **and persisted**; the site stops asking from then on
 *   dismiss    refused without persisting, but counted — three in a row stop the site asking
 *   ignore     the same, at four
 *
 * Only a permission prompt reads the action (other popups ignore it), and a prompt offers only
 * some of the five. **Which ones is in its availableActions in the snapshot** — the kernel
 * validates and its refusal lists what it does offer.
 */
const POPUP_ACTIONS = new Set([
  "allowonce",
  "allow",
  "deny",
  "dismiss",
  "ignore",
]);

/** Find a tab in the window list, to read state such as canGoBack/isAudible that should be known before calling. */
export function findTab(
  windows: WindowInfo[],
  windowId: string,
  tabId: string,
): TabInfo | undefined {
  return windows
    .find((win) => win.windowId === windowId)
    ?.tabs.find((tab) => tab.tabId === tabId);
}

/** Open a new browser window (wrapping Embiody.browserNewWindow). Returns the new windowId/tabId. */
export async function browserNewWindow(
  cdp: CdpClient,
  params: { url?: string; hideWindow?: boolean; incognito?: boolean },
): Promise<ActionResult> {
  // hideWindow false (the default) shows the window maximised on screen.
  const result: any = await cdp.sendCommand("Embiody.browserNewWindow", {
    url: params.url,
    hideWindow: params.hideWindow ?? false,
    incognito: params.incognito ?? false,
  });
  if (result?.success === false) {
    return { ok: false, text: `Opening a new window failed: ${resultError(result, "unknown")}` };
  }
  const windowId = readId(result?.windowId);
  const tabId = readId(result?.tabId);
  if (!windowId || !tabId) {
    return {
      ok: false,
      text: `Opening a new window failed: the kernel returned no usable windowId/tabId (${JSON.stringify(result).slice(0, 200)})`,
    };
  }
  return {
    ok: true,
    text: `Opened a browser window, windowId=${windowId}, tabId=${tabId}`,
    data: { windowId, tabId, url: params.url ?? "about:blank" },
  };
}

/** Navigate the current tab to a URL (wrapping Embiody.browserNavigate; does not open a tab). */
export async function browserNavigate(
  cdp: CdpClient,
  params: {
    url: string;
    windowId?: string;
    tabId?: string;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  if (!params.url) {
    return { ok: false, text: "browserNavigate is missing url" };
  }
  const target = requireTarget("browserNavigate", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }

  let reply: NavigationReply;
  try {
    reply = await cdp.sendCommand(
      "Embiody.browserNavigate",
      withWaitParams(
        { url: params.url, windowId: target.windowId, tabId: target.tabId },
        params,
      ),
    );
  } catch (error) {
    return { ok: false, text: `Navigation failed: ${errorMessage(error)}` };
  }
  return describeNavigation(`Navigate to ${params.url}`, reply, target);
}

/**
 * Open a new tab (wrapping Embiody.browserNewTab). One hop returns windowId/tabId/title/url/
 * loadStatus, and the tab is an agent tab from birth.
 * It opens in the background by default: a background tab still works at full speed and can be
 * snapshotted, and bringing it forward takes the window from whoever is reading it.
 */
export async function browserAddNewTab(
  cdp: CdpClient,
  params: {
    url?: string;
    windowId?: string;
    foreground?: boolean;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  const win = requireWindow("browserAddNewTab", params.windowId);
  if (isTargetError(win)) {
    return { ok: false, text: win.error };
  }

  let reply: NavigationReply;
  try {
    reply = await cdp.sendCommand(
      "Embiody.browserNewTab",
      withWaitParams(
        {
          windowId: win.windowId,
          url: params.url ?? "about:blank",
          foreground: params.foreground ?? false,
        },
        params,
      ),
    );
  } catch (error) {
    return { ok: false, text: `Opening a new tab failed: ${errorMessage(error)}` };
  }

  const outcome = describeNavigation(
    `Open a new tab in window ${win.windowId} (${params.url ?? "about:blank"})`,
    reply,
    { windowId: win.windowId },
  );
  const newTabId = outcome.data?.tabId;

  // Opening a tab and loading a page are two things: once the kernel returns a tabId the tab
  // exists, even if that page failed to load. Reporting failure here would be wrong — it would
  // throw the tabId away too, leaking a tab in the window that the model neither knows about
  // nor can navigate, and a retry would just leak another. The right account is: here is your
  // tab, the page did not load, decide where to navigate next.
  if (!outcome.ok && newTabId) {
    return {
      ok: true,
      text: `${outcome.text}. The tab itself was created (tabId=${newTabId}) and the runtime switched to it, but the page did not load. Give it an address with browserNavigate`,
      data: outcome.data,
    };
  }
  if (!outcome.ok) return outcome;
  if (!newTabId) {
    return {
      ok: false,
      text: `Opening a new tab gave an unreadable result: the kernel reply carries no tabId (${JSON.stringify(reply).slice(0, 200)}). Take a layout with browserGetWindowInfo to see whether a tab opened`,
      data: outcome.data,
    };
  }
  // The new tab's tabId is what every later command needs, so say it explicitly.
  outcome.text = `${outcome.text}, new tab tabId=${newTabId}`;
  return outcome;
}

/** Go back one step (wrapping Embiody.browserGoBack). With no history entry the kernel errors outright rather than succeeding falsely. */
export async function browserGoBack(
  cdp: CdpClient,
  params: {
    windowId?: string;
    tabId?: string;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  return goHistory(cdp, "browserGoBack", "Embiody.browserGoBack", "Go back", params);
}

/** Go forward one step (wrapping Embiody.browserGoForward). Can only succeed after going back. */
export async function browserGoForward(
  cdp: CdpClient,
  params: {
    windowId?: string;
    tabId?: string;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  return goHistory(
    cdp,
    "browserGoForward",
    "Embiody.browserGoForward",
    "Go forward",
    params,
  );
}

async function goHistory(
  cdp: CdpClient,
  action: string,
  method: string,
  intent: string,
  params: {
    windowId?: string;
    tabId?: string;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  const target = requireTarget(action, params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }

  let reply: NavigationReply;
  try {
    reply = await cdp.sendCommand(
      method,
      withWaitParams({ windowId: target.windowId, tabId: target.tabId }, params),
    );
  } catch (error) {
    // Having no history entry to go to takes this path: the kernel refuses with a ServerError
    // rather than returning a success the caller has to doubt. Translated into something the
    // model can change approach on.
    const message = errorMessage(error);
    if (/no earlier entry|no later entry|Cannot go (back|forward)/i.test(message)) {
      return {
        ok: false,
        text: `${intent} failed: this tab has no history entry to move to (${message}). Do not retry; use browserNavigate to go straight to the target URL`,
      };
    }
    return { ok: false, text: `${intent} failed: ${message}` };
  }
  // Going back is often a same-document navigation (an anchor, or a history entry the page
  // pushed itself), which does not load, repaint or change the title, so loadStatus is
  // committed — that is a normal arrival, not "only got halfway".
  return describeNavigation(intent, reply, target);
}

/** Reload the current page (wrapping Embiody.browserReload). A form page refuses to resubmit by default; see formResubmission. */
export async function browserReload(
  cdp: CdpClient,
  params: {
    windowId?: string;
    tabId?: string;
    bypassCache?: boolean;
    resubmitForm?: boolean;
    waitUntil?: string;
    timeoutMs?: number;
  },
): Promise<ActionResult> {
  const target = requireTarget("browserReload", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }

  let reply: NavigationReply;
  try {
    reply = await cdp.sendCommand(
      "Embiody.browserReload",
      withWaitParams(
        {
          windowId: target.windowId,
          tabId: target.tabId,
          bypassCache: params.bypassCache ?? false,
          resubmitForm: params.resubmitForm ?? false,
        },
        params,
      ),
    );
  } catch (error) {
    return { ok: false, text: `Reload failed: ${errorMessage(error)}` };
  }
  return describeNavigation(
    `Reload the page${params.bypassCache ? " (bypassing cache)" : ""}`,
    reply,
    target,
  );
}

/**
 * Stop loading (wrapping Embiody.browserStopLoading).
 * For pages that spin forever: after browserNavigate returns on its own deadline the page goes
 * on fetching. The reply holds only wasLoading and no success — false is not a failure, it
 * means loading had already finished.
 */
export async function browserStopLoading(
  cdp: CdpClient,
  params: { windowId?: string; tabId?: string },
): Promise<ActionResult> {
  const target = requireTarget("browserStopLoading", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserStopLoading", {
      windowId: target.windowId,
      tabId: target.tabId,
    });
  } catch (error) {
    return { ok: false, text: `Stopping the load failed: ${errorMessage(error)}` };
  }
  return {
    ok: true,
    text: result?.wasLoading
      ? "Loading stopped; the tab stays on whatever content had arrived. This is not a navigation and the page does not change"
      : "Nothing to stop: this tab had already finished loading",
    data: { wasLoading: !!result?.wasLoading },
  };
}

/**
 * Mute or unmute the current tab (wrapping Embiody.browserSetAudioMuted).
 * It is a property of the tab, not the site: it lives with the tab, survives navigation, and
 * does not affect other tabs on the same site.
 */
export async function browserSetAudioMuted(
  cdp: CdpClient,
  params: { muted: boolean; windowId?: string; tabId?: string },
): Promise<ActionResult> {
  const target = requireTarget("browserSetAudioMuted", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserSetAudioMuted", {
      windowId: target.windowId,
      tabId: target.tabId,
      muted: !!params.muted,
    });
  } catch (error) {
    return { ok: false, text: `Setting mute failed: ${errorMessage(error)}` };
  }
  if (result?.success === false) {
    return { ok: false, text: `Setting mute failed: ${resultError(result, "the kernel refused")}` };
  }
  // muted is the actual state read back from the tab, not an echo of the request — go by it.
  // When the reply has no such field we know nothing about the outcome and must not announce a
  // state on the kernel's behalf.
  if (typeof result?.muted !== "boolean") {
    return {
      ok: false,
      text: `The mute result cannot be confirmed: the kernel reply has no muted field (${JSON.stringify(result).slice(0, 200)})`,
    };
  }
  return {
    ok: true,
    text: result.muted ? "Tab muted" : "Tab unmuted",
    data: { muted: result.muted },
  };
}

/**
 * Why a close that replied success:false left the tab or window there. The kernel replies once
 * it is gone, or after 10 s.
 */
const STILL_OPEN =
  "a person was asked and declined, or the page asked \"Leave site?\" and it was not answered " +
  "within 10 s. That question is for a person: hand the tab over with " +
  "browser_start_human_control, or leave it open. Do not send the close again: a second " +
  "close while the question is up closes the page without asking, losing what it wanted kept";

/**
 * Close a tab (wrapping Embiody.browserCloseTab). The kernel replies once the tab is gone, so
 * remainingTabsCount is exact. A false success is checked against the layout: measured on F0, a
 * second close sent while the first one's "Leave site?" was up closed the tab and still said false.
 */
export async function browserCloseTab(
  cdp: CdpClient,
  params: { windowId?: string; tabId?: string },
): Promise<ActionResult> {
  const target = requireTarget("browserCloseTab", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserCloseTab", {
      windowId: target.windowId,
      tabId: target.tabId,
    });
  } catch (error) {
    return { ok: false, text: `Closing the tab failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    const layout = await browserGetWindowInfo(cdp).catch(() => undefined);
    if (layout && !findTab(layout, target.windowId, target.tabId)) {
      const w = layout.find((x) => x.windowId === target.windowId);
      return { ok: true, text: `Tab closed (${w ? w.tabs.length : 0} remaining)` };
    }
    return { ok: false, text: `The tab is still open: ${STILL_OPEN}` };
  }
  return {
    ok: true,
    text: `Tab closed (${result.remainingTabsCount ?? "?"} remaining)`,
  };
}

/** Close a browser window (wrapping Embiody.browserCloseWindow, which takes windowId). Replies as browserCloseTab does. */
export async function browserCloseWindow(
  cdp: CdpClient,
  params: { windowId?: string },
): Promise<ActionResult> {
  const win = requireWindow("browserCloseWindow", params.windowId);
  if (isTargetError(win)) {
    return { ok: false, text: win.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserCloseWindow", {
      windowId: win.windowId,
    });
  } catch (error) {
    return { ok: false, text: `Closing the window failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    const layout = await browserGetWindowInfo(cdp).catch(() => undefined);
    if (layout && !layout.some((w) => w.windowId === win.windowId)) {
      return { ok: true, text: `Closed browser window windowId=${win.windowId}` };
    }
    return { ok: false, text: `The window is still open: ${STILL_OPEN}` };
  }
  return { ok: true, text: `Closed browser window windowId=${win.windowId}` };
}

/**
 * Make a tab the one its window shows (wrapping Embiody.browserSelectTab). Not needed before a
 * snapshot: background tabs and hidden windows are captured as they are. Throws on failure.
 */
export async function browserSelectTab(
  cdp: CdpClient,
  params: { windowId: string; tabId: string },
): Promise<void> {
  await cdp.sendCommand("Embiody.browserSelectTab", {
    windowId: params.windowId,
    tabId: params.tabId,
  });
}

/**
 * Show a browser window, restoring it from minimised or hidden (wrapping Embiody.browserShow).
 *
 * toState:
 *   omitted     -- show in place, keeping the window's current placement
 *   "Restore"   -- restore to its previous size and bring to front
 *   "Maximized" -- fill the screen and bring to front
 * Both placements bring the window to the very front (on Windows that is SW_RESTORE /
 * SW_SHOWMAXIMIZED), so pass one only when this window really is meant to be seen or captured.
 */
export async function browserShow(
  cdp: CdpClient,
  params: { windowId: string; toState?: "Restore" | "Maximized" },
): Promise<void> {
  const payload: Record<string, unknown> = { windowId: params.windowId };
  if (params.toState) payload.toState = params.toState;
  await cdp.sendCommand("Embiody.browserShow", payload);
}

/**
 * Minimize a window (wrapping the standard Browser.setWindowBounds; the Embiody domain has no
 * minimize). browserShow brings it back.
 *
 * Embiody's windowId is the same number as the standard domain's (measured 2026-09-26), so
 * it is passed through. Pages in a minimized Embiody window keep full speed: timers at 10/s
 * and a countdown still on time after 5.5 minutes minimized, where Chrome drops to once a
 * minute. Reproduce with scripts/pages/background_speed_probe.html.
 */
export async function browserMinimize(
  cdp: CdpClient,
  params: { windowId: string },
): Promise<ActionResult> {
  const id = Number(params.windowId);
  if (!Number.isInteger(id)) {
    return { ok: false, text: `browserMinimize needs a numeric windowId, got "${params.windowId}"` };
  }
  try {
    // Only the agent's own windows: setWindowBounds is not behind the browser's "ask before
    // touching a person's tab" check. A window counts as the agent's when every tab in it is
    // AI-controlled, the rule the browser uses when the agent closes a window (AgentCloseWindow).
    const win = (await browserGetWindowInfo(cdp)).find((w) => w.windowId === params.windowId);
    if (!win) {
      return { ok: false, text: `No window ${params.windowId}` };
    }
    if (win.tabs.length === 0 || !win.tabs.every((t) => t.isAgentTab)) {
      return {
        ok: false,
        text: `Window ${params.windowId} has tabs that are not the agent's, so it was not minimized; only windows whose every tab is yours (opened by you, or handed to you) can be minimized`,
      };
    }
    await cdp.sendCommand("Browser.setWindowBounds", {
      windowId: id,
      bounds: { windowState: "minimized" },
    });
  } catch (error) {
    return { ok: false, text: `Minimizing failed: ${errorMessage(error)}` };
  }
  return { ok: true, text: `Window ${params.windowId} minimized` };
}

/**
 * Close a popup open on the page (wrapping Embiody.browserClosePopupBubble): permission
 * bubbles (handled per action), toolbar and address bar bubbles, modal dialogs, the address
 * bar dropdown, the three-dot and bookmark menus, the task manager, and blocking native
 * dialogs on Windows such as Save As.
 * The only ones it leaves alone are the dialogs asking the user whether to take over an AI tab
 * — those ask a person about the agent, and the agent must not answer for them.
 */
export async function browserClosePopupBubble(
  cdp: CdpClient,
  params: {
    /** See POPUP_ACTIONS; omitted means dismiss (refuse without writing to the profile, the most conservative one). */
    action?: string;
    windowId?: string;
    tabId?: string;
  },
): Promise<ActionResult> {
  const target = requireTarget("browserClosePopupBubble", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  // Only block values that are plainly none of the five — "which ones does this popup actually
  // accept" is the kernel's call, and its refusal lists the values that popup offers, which
  // beats anything we could guess.
  const asked = (params.action ?? "dismiss").trim();
  if (!POPUP_ACTIONS.has(asked.toLowerCase())) {
    return {
      ok: false,
      text: `The action for browserClosePopupBubble must be one of allowOnce/allow/deny/dismiss/ignore, but got "${asked}". When unsure use dismiss, which refuses without writing to the profile`,
    };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserClosePopupBubble", {
      action: asked,
      windowId: target.windowId,
      tabId: target.tabId,
    });
  } catch (error) {
    return { ok: false, text: `Closing the popup failed: ${errorMessage(error)}` };
  }
  const types = Array.isArray(result?.types) ? result.types.join(", ") : "";
  // appliedAction says what was actually done to the permission bubble, in the kernel's own
  // spelling. It is absent when there was no permission bubble to answer — which is not the
  // same thing as an empty string.
  const appliedAction =
    typeof result?.appliedAction === "string" && result.appliedAction
      ? result.appliedAction
      : undefined;
  if (!result?.closed) {
    return {
      ok: true,
      // Not "there was none": a page's "Leave site?" question is up yet not closable (F0, measured).
      text: "Nothing was closed: no popup, bubble or menu this command can close is open. A page's own \"Leave site?\" question is not one of them; that needs a person",
      data: { closed: false },
    };
  }
  const applied = appliedAction
    ? `; applied ${appliedAction} to the permission bubble${
        /^allow$|^deny$/i.test(appliedAction)
          ? " (this decision **was written into the browser profile** and outlives this task)"
          : ""
      }`
    : "";
  return {
    ok: true,
    text: `Popup closed${types ? ` (${types})` : ""}${applied}`,
    data: { closed: true, types: result.types, appliedAction },
  };
}

/**
 * Hand the tab to a person (wrapping Embiody.browserStartHumanControl).
 * The tab stops being an agent tab, and physical keyboard and mouse reach the page again — a password,
 * a verification code, scanning a QR code and anything else only a person can do must go
 * through here, because in an agent tab they simply cannot type.
 *
 * While it is handed over, every Embiody command on that tab fails except takeSnapshot
 * (reading): click/inputText/scroll/navigate/selectTab/closeTab/closePopupBubble. Snapshots
 * still work, and that is precisely how to notice the person has finished.
 *
 * showWindow defaults to true: a window of agent tabs is often hidden or off screen, and asking
 * someone to type into a window they cannot see does not work.
 */
export async function browserStartHumanControl(
  cdp: CdpClient,
  params: { windowId?: string; tabId?: string; showWindow?: boolean },
): Promise<ActionResult> {
  const target = requireTarget("browserStartHumanControl", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserStartHumanControl", {
      windowId: target.windowId,
      tabId: target.tabId,
      showWindow: params.showWindow ?? true,
    });
  } catch (error) {
    return { ok: false, text: `Handing over to a human failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    return {
      ok: false,
      text: `Handing over to a human failed: ${resultError(result, "the kernel refused")}`,
    };
  }
  return {
    ok: true,
    text: "The tab has been handed to a human: the window is in front and the physical keyboard and mouse work. Until it is taken back, everything except snapshots fails; to resume automation you must call browserStopHumanControl first",
    data: { humanControl: true },
  };
}

/**
 * Take the tab back and resume automating it (wrapping Embiody.browserStopHumanControl).
 * A handover the agent started (reason=agentRequested) can be ended by the agent; one the
 * person started (reason=userTookOver) is theirs, so they are asked first and success=false if
 * they refuse. That question times out after ten seconds and lets it through — the common case
 * is that nobody is watching (the window was clicked by accident while off screen).
 */
export async function browserStopHumanControl(
  cdp: CdpClient,
  params: { windowId?: string; tabId?: string },
): Promise<ActionResult> {
  const target = requireTarget("browserStopHumanControl", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserStopHumanControl", {
      windowId: target.windowId,
      tabId: target.tabId,
    });
  } catch (error) {
    return { ok: false, text: `Taking control back failed: ${errorMessage(error)}` };
  }
  const reason = String(result?.reason ?? "");
  if (!result?.success) {
    return {
      ok: false,
      text: `Taking control back was refused (reason=${reason || "unknown"}): a human took this tab over deliberately and has not given it back. The task cannot continue automatically`,
      data: { reason },
    };
  }
  if (reason === "none") {
    return {
      ok: true,
      text: "This tab was not under human control, so there is nothing to take back",
      data: { reason },
    };
  }
  return {
    ok: true,
    text: `Control taken back (the earlier handover came from ${reason === "userTookOver" ? "a human taking over" : "the agent handing over"}); automation can continue`,
    data: { reason },
  };
}

/**
 * Click (wrapping Embiody.browserClick).
 * Given an emsn, the kernel asks the renderer live where that node is *now* before clicking,
 * and validates the hit: a node that is gone, a frame that is gone, something that cannot be
 * scrolled into view, or one covered by another element (including content outside a
 * cross-process iframe) is refused with -32602 rather than pretending to succeed. None of
 * those are retryable; a fresh snapshot next round is needed to pick a new target.
 */
export async function browserClick(
  cdp: CdpClient,
  params: {
    x?: number;
    y?: number;
    emsn?: number;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    windowId?: string;
    tabId?: string;
    /** The id of this batch of numbers, from this round's snapshot of that tab. Required by the kernel, which validates it. */
    snapshotId?: string;
  },
): Promise<ActionResult> {
  if (
    params.emsn === undefined &&
    (params.x === undefined || params.y === undefined)
  ) {
    return { ok: false, text: "browserClick requires either emsn or x,y" };
  }
  // The order matters: confirm the target (windowId/tabId) first, then the batch id. The target
  // is the more fundamental of the two — when both are missing, saying so about the target
  // first matches the caller's own mental order.
  const target = requireTarget("browserClick", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId("browserClick", params.snapshotId, params.tabId);
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }
  // With an emsn, click by element only (the kernel locates it live and validates occlusion)
  // and send no coordinates — explicit coordinates bypass every check, which means giving up
  // the kernel's protection.
  const clickPayload: Record<string, unknown> = {
    emsn: params.emsn,
    button: params.button ?? "left",
    clickCount: params.clickCount ?? 1,
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
  };
  if (params.emsn === undefined) {
    clickPayload.x = params.x;
    clickPayload.y = params.y;
  }

  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserClick", clickPayload);
  } catch (error) {
    return { ok: false, text: `Click failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    return { ok: false, text: `Click failed: ${resultError(result, "the kernel refused the click")}` };
  }
  return {
    ok: true,
    text: withKernelMessage(
      `Clicked (${params.button ?? "left"} x${params.clickCount ?? 1})`,
      result,
    ),
  };
}

/**
 * Type text (wrapping Embiody.browserInputText).
 * The same validation as browserClick, plus one retryable failure: the kernel hit the input
 * but could not confirm within ten seconds that the target frame took input focus (a busy
 * renderer). Not a character was entered, and one retry is enough.
 */
export async function browserInputText(
  cdp: CdpClient,
  params: {
    text: string;
    clearText?: boolean;
    pressEnter?: boolean;
    emsn?: number;
    windowId?: string;
    tabId?: string;
    /** As for browserClick: required by the kernel, which validates it even for "type into whatever has focus" with no emsn. */
    snapshotId?: string;
    /** Where in emsn's text to type; at most one of before/after/replace/at. */
    before?: string;
    after?: string;
    replace?: string;
    at?: "start" | "end";
    occurrence?: number;
  },
): Promise<ActionResult> {
  const target = requireTarget("browserInputText", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId(
    "browserInputText",
    params.snapshotId,
    params.tabId,
  );
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }
  const attempt = await sendRetryingFocus(cdp, "Embiody.browserInputText", {
    text: params.text ?? "",
    clearText: params.clearText ?? false,
    pressEnter: params.pressEnter ?? false,
    emsn: params.emsn,
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
    before: params.before,
    after: params.after,
    replace: params.replace,
    at: params.at,
    occurrence: params.occurrence,
  });
  if (attempt.error) {
    return { ok: false, text: `Typing failed: ${attempt.error}` };
  }

  const result = attempt.result;
  if (!result?.success) {
    return { ok: false, text: `Typing failed: ${resultError(result, "the kernel refused the input")}` };
  }
  // The changed lines as read back, caret marked.
  const edited =
    typeof result.editedText === "string" ? `; now reads: ${JSON.stringify(result.editedText)}` : "";
  return {
    ok: true,
    text: withKernelMessage(
      `Text typed (clearText=${params.clearText ?? false}, pressEnter=${params.pressEnter ?? false})${edited}`,
      result,
    ),
  };
}

/**
 * Press keys where focus is (wrapping Embiody.browserPressKey). The kernel presses
 * nothing if any key is refused, replies once the page has handled the last one, and does not
 * say what they did. Retried once after a focus timeout, as browserInputText is.
 */
export async function browserPressKey(
  cdp: CdpClient,
  params: {
    keys: Array<{ key: string; repeatCount?: number }>;
    repeatDelayMs?: number;
    /** Focus this first; clicked unless focus is already in it. */
    emsn?: number;
    windowId?: string;
    tabId?: string;
    /** As for browserInputText: required even without emsn. */
    snapshotId?: string;
  },
): Promise<ActionResult> {
  const target = requireTarget("browserPressKey", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId("browserPressKey", params.snapshotId, params.tabId);
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }
  const attempt = await sendRetryingFocus(cdp, "Embiody.browserPressKey", {
    keys: params.keys,
    repeatDelayMs: params.repeatDelayMs,
    emsn: params.emsn,
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
  });
  if (attempt.error) {
    return { ok: false, text: `Key press failed: ${attempt.error}` };
  }
  const result = attempt.result;
  if (!result?.success) {
    return { ok: false, text: `Key press failed: ${resultError(result, "the kernel refused the keys")}` };
  }
  const shown = params.keys
    .map((k) => ((k.repeatCount ?? 1) > 1 ? `${k.key} x${k.repeatCount}` : k.key))
    .join(", ");
  return { ok: true, text: withKernelMessage(`Pressed ${shown}`, result) };
}

/**
 * Select words in an editable element, as a person drags over them (wrapping
 * Embiody.browserSelectEditableText), for a toolbar button to act on next. Which way to select
 * (select, from+to, all) is checked by the kernel, which says what is wrong. Retried once after a
 * focus timeout, as typing is.
 */
export async function browserSelectEditableText(
  cdp: CdpClient,
  params: {
    emsn: number;
    select?: string;
    from?: string;
    to?: string;
    all?: boolean;
    occurrence?: number;
    toOccurrence?: number;
    windowId?: string;
    tabId?: string;
    snapshotId?: string;
  },
): Promise<ActionResult> {
  const target = requireTarget("browserSelectEditableText", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId("browserSelectEditableText", params.snapshotId, params.tabId);
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }
  const attempt = await sendRetryingFocus(cdp, "Embiody.browserSelectEditableText", {
    emsn: params.emsn,
    select: params.select,
    from: params.from,
    to: params.to,
    all: params.all,
    occurrence: params.occurrence,
    toOccurrence: params.toOccurrence,
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
  });
  if (attempt.error) {
    return { ok: false, text: `Selecting failed: ${attempt.error}` };
  }
  const result = attempt.result;
  if (!result?.success) {
    return { ok: false, text: `Selecting failed: ${resultError(result, "the kernel refused the selection")}` };
  }
  const lines = typeof result.selectedText === "string" ? `: ${JSON.stringify(result.selectedText)}` : "";
  return { ok: true, text: withKernelMessage(`Selected${lines}`, result) };
}

/**
 * Scroll (wrapping Embiody.browserScroll).
 *
 * deltaX/deltaY count the way scrollLeft/scrollTop do: positive is right / down (the retired
 * xDistance/yDistance had the opposite sign).
 *
 * What scrolls is whatever sits under the pointer. onEmsn (or onX,onY) moves the pointer there
 * first and it stays; onEmsn -1 is the blank area, i.e. the document itself, and the kernel
 * refuses it unless the latest snapshot's scroll chain offered it. toX/toY say where to end up
 * rather than how far, and past the end is the end.
 *
 * The reply waits until the scroll is at rest (toX/toY: until it arrives), so a snapshot right
 * after shows where it ended up; how far it really went is in the kernel's message.
 * timeoutMs bounds **the whole command, every repeat included** (pdl; measured: 12 wheels of
 * 200px at the 7 s default failed after scrolling 2163px), so a repeated scroll left without
 * one gets room for each wheel here.
 */
export async function browserScroll(
  cdp: CdpClient,
  params: {
    deltaX?: number;
    deltaY?: number;
    toX?: number;
    toY?: number;
    onEmsn?: number;
    onX?: number;
    onY?: number;
    repeatCount?: number;
    repeatDelayMs?: number;
    speed?: number;
    /** How long the scroll may take to come to rest or arrive; past it the command fails. */
    timeoutMs?: number;
    windowId?: string;
    tabId?: string;
    /** Required with onEmsn / onX,onY, as for browserClick. */
    snapshotId?: string;
  },
): Promise<ActionResult> {
  // Caught here rather than on the wire so the caller is told what to fix, not just "invalid".
  const hasDelta = !!params.deltaX || !!params.deltaY;
  const hasTo = params.toX !== undefined || params.toY !== undefined;
  if (!hasDelta && !hasTo) {
    return { ok: false, text: "browserScroll needs deltaY/deltaX (how far) or toY/toX (where to end up)" };
  }
  if (hasDelta && hasTo) {
    return { ok: false, text: "browserScroll takes either deltaX/deltaY (how far) or toX/toY (where to end up), not both" };
  }
  if (hasTo && (params.repeatCount ?? 1) > 1) {
    return { ok: false, text: "browserScroll cannot repeat toX/toY: repeating a destination means nothing, drop repeatCount" };
  }
  if (halfAPoint(params.onX, params.onY)) {
    return { ok: false, text: "browserScroll needs both onX and onY, not one of them" };
  }
  const target = requireTarget("browserScroll", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const payload: Record<string, unknown> = {
    windowId: target.windowId,
    tabId: target.tabId,
  };
  const aimed = params.onEmsn !== undefined || params.onX !== undefined;
  if (aimed) {
    const batch = requireSnapshotId("browserScroll", params.snapshotId, params.tabId);
    if (isTargetError(batch)) {
      return { ok: false, text: batch.error };
    }
    payload.snapshotId = batch.snapshotId;
    if (params.onEmsn !== undefined) payload.onEmsn = params.onEmsn;
    if (params.onX !== undefined && params.onY !== undefined) {
      payload.onX = params.onX;
      payload.onY = params.onY;
    }
  }
  // Zero distances stay off the wire: an axis not given is an axis not moved.
  if (params.deltaX) payload.deltaX = params.deltaX;
  if (params.deltaY) payload.deltaY = params.deltaY;
  if (params.toX !== undefined) payload.toX = params.toX;
  if (params.toY !== undefined) payload.toY = params.toY;
  if (params.repeatCount !== undefined) payload.repeatCount = params.repeatCount;
  if (params.repeatDelayMs !== undefined) {
    payload.repeatDelayMs = params.repeatDelayMs;
  }
  if (params.speed !== undefined) payload.speed = params.speed;
  const repeats = Math.max(1, params.repeatCount ?? 1);
  const timeoutMs =
    params.timeoutMs ??
    (repeats > 1
      ? SCROLL_TIMEOUT_MS + (repeats - 1) * ((params.repeatDelayMs ?? 300) + SCROLL_WHEEL_MS)
      : undefined);
  if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;

  let result: any;
  try {
    result = await cdp.sendCommand(
      "Embiody.browserScroll",
      payload,
      Math.max(CDP_COMMAND_TIMEOUT_MS, (timeoutMs ?? SCROLL_TIMEOUT_MS) + SCROLL_CDP_MARGIN_MS),
    );
  } catch (error) {
    // A deadline reached mid-way leaves the page wherever the wheels got it.
    const message = errorMessage(error);
    const partway = /within \d+ ?ms/.test(message) && !/browserTakeSnapshot/.test(message)
      ? " It may have moved part of the way; take a snapshot before going on."
      : "";
    return { ok: false, text: `Scroll failed: ${message}${partway}` };
  }
  if (!result?.success) {
    return { ok: false, text: `Scroll failed: ${resultError(result, "the kernel refused the scroll")}` };
  }
  const how = hasTo
    ? `to [X:${params.toX ?? "unchanged"}, Y:${params.toY ?? "unchanged"}]`
    : `by [X:${params.deltaX ?? 0}px, Y:${params.deltaY ?? 0}px]${repeats > 1 ? ` x${repeats}` : ""}`;
  const where = params.onEmsn !== undefined
    ? ` at emsn=${params.onEmsn}`
    : params.onX !== undefined
      ? ` at (${params.onX}, ${params.onY})`
      : "";
  // The reply carries no position by design: where it landed is read from the next snapshot.
  // A delta is what was sent, not what moved: the kernel's note says when the page took some or all of it.
  const done = hasTo ? `Scrolled ${how}${where}` : `Scroll ${how}${where} sent, now at rest`;
  return { ok: true, text: withKernelMessage(done, result) };
}

/** The kernel's default for browserScroll's timeoutMs. */
const SCROLL_TIMEOUT_MS = 7000;
/** Room per extra wheel of a repeated scroll; one wheel and its settling measured 0.3-1.6 s. */
const SCROLL_WHEEL_MS = 2000;
/** The connection waits this much past the kernel's own deadline before giving up on a reply. */
const SCROLL_CDP_MARGIN_MS = 5000;

/** One coordinate of a pair given without the other. Dropping it silently would aim somewhere the caller never asked for. */
function halfAPoint(a: number | undefined, b: number | undefined): boolean {
  return (a === undefined) !== (b === undefined);
}

/**
 * Hover (wrapping Embiody.browserMove). The pointer walks there and stays.
 *
 * The reply's x,y is worth reporting back: an emsn is aimed at the element's live centre, not
 * at where the snapshot said it was, and a later command naming a point has to start from
 * where the pointer actually is.
 */
export async function browserMove(
  cdp: CdpClient,
  params: {
    x?: number;
    y?: number;
    emsn?: number;
    windowId?: string;
    tabId?: string;
    /** As for browserClick: required by the kernel, which validates it for a point target too. */
    snapshotId?: string;
  },
): Promise<ActionResult> {
  if (halfAPoint(params.x, params.y)) {
    return { ok: false, text: "browserMove needs both x and y, not one of them" };
  }
  if (params.emsn === undefined && params.x === undefined) {
    return { ok: false, text: "browserMove requires either emsn or x,y" };
  }
  const target = requireTarget("browserMove", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId("browserMove", params.snapshotId, params.tabId);
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }
  // With an emsn, x,y name a spot *inside* that element, and a point outside it is refused —
  // so they are only sent when the caller gave both alongside the number.
  const payload: Record<string, unknown> = {
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
  };
  if (params.emsn !== undefined) payload.emsn = params.emsn;
  if (params.x !== undefined && params.y !== undefined) {
    payload.x = params.x;
    payload.y = params.y;
  }

  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserMove", payload);
  } catch (error) {
    return { ok: false, text: `Hover failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    return { ok: false, text: `Hover failed: ${resultError(result, "the kernel refused the hover")}` };
  }
  return {
    ok: true,
    text: withKernelMessage(
      `Pointer moved to (${result.x}, ${result.y})`,
      result,
    ),
  };
}

/**
 * Press, carry, release (wrapping Embiody.browserDrag). The one gesture nothing else here can
 * make: browserClick presses and releases in the same spot, so sliders, canvas panning, split
 * bars and reorderable lists need this.
 *
 * Both ends must be on screen at once. The start is scrolled into view if it needs it; the end
 * is not, because scrolling it in would carry the start back off, so an end outside the
 * viewport is refused and the way past it is to scroll first.
 */
export async function browserDrag(
  cdp: CdpClient,
  params: {
    x?: number;
    y?: number;
    emsn?: number;
    toEmsn?: number;
    toX?: number;
    toY?: number;
    dx?: number;
    dy?: number;
    button?: "left" | "right" | "middle";
    holdMs?: number;
    settleMs?: number;
    windowId?: string;
    tabId?: string;
    snapshotId?: string;
  },
): Promise<ActionResult> {
  if (halfAPoint(params.x, params.y)) {
    return { ok: false, text: "browserDrag needs both x and y, not one of them" };
  }
  if (halfAPoint(params.toX, params.toY)) {
    return { ok: false, text: "browserDrag needs both toX and toY, not one of them" };
  }
  if (params.emsn === undefined && params.x === undefined) {
    return { ok: false, text: "browserDrag requires either emsn or x,y for where the press lands" };
  }
  // Three ways to say where the button comes up, and the kernel refuses a mix. Caught here
  // rather than on the wire so the caller is told which three, not just "invalid".
  const toPoint = params.toX !== undefined && params.toY !== undefined;
  const hasTo = params.toEmsn !== undefined || toPoint;
  const hasDelta = params.dx !== undefined || params.dy !== undefined;
  if (!hasTo && !hasDelta) {
    return {
      ok: false,
      text:
        "browserDrag needs a destination: toEmsn (optionally with toX,toY for a spot inside it), " +
        "or toX and toY for a point, or dx and dy for an offset from where the press landed",
    };
  }
  if (hasTo && hasDelta) {
    return { ok: false, text: "browserDrag takes either a destination (toEmsn / toX,toY) or an offset (dx,dy), not both" };
  }
  const target = requireTarget("browserDrag", params);
  if (isTargetError(target)) {
    return { ok: false, text: target.error };
  }
  const batch = requireSnapshotId("browserDrag", params.snapshotId, params.tabId);
  if (isTargetError(batch)) {
    return { ok: false, text: batch.error };
  }

  const payload: Record<string, unknown> = {
    windowId: target.windowId,
    tabId: target.tabId,
    snapshotId: batch.snapshotId,
  };
  if (params.emsn !== undefined) payload.emsn = params.emsn;
  if (params.x !== undefined && params.y !== undefined) {
    payload.x = params.x;
    payload.y = params.y;
  }
  if (params.toEmsn !== undefined) payload.toEmsn = params.toEmsn;
  if (toPoint) {
    payload.toX = params.toX;
    payload.toY = params.toY;
  }
  if (params.dx !== undefined) payload.dx = params.dx;
  if (params.dy !== undefined) payload.dy = params.dy;
  if (params.button !== undefined) payload.button = params.button;
  if (params.holdMs !== undefined) payload.holdMs = params.holdMs;
  if (params.settleMs !== undefined) payload.settleMs = params.settleMs;

  let result: any;
  try {
    result = await cdp.sendCommand("Embiody.browserDrag", payload);
  } catch (error) {
    return { ok: false, text: `Drag failed: ${errorMessage(error)}` };
  }
  if (!result?.success) {
    return { ok: false, text: `Drag failed: ${resultError(result, "the kernel refused the drag")}` };
  }
  return {
    ok: true,
    text: withKernelMessage(
      `Dragged (${result.x}, ${result.y}) -> (${result.toX}, ${result.toY})`,
      result,
    ),
  };
}

/** Wait (for a page transition or load, giving the page time before the next round of observation). durationMs defaults to 2000, clamped to 100-10000. */
export async function browserWait(
  _cdp: CdpClient,
  params: { durationMs?: number },
): Promise<ActionResult> {
  const asked = Number(params.durationMs ?? 2000);
  const ms = Math.min(Math.max(asked, 100), 10000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ok: true, text: asked > ms ? `Waited ${ms}ms, the most one call waits` : `Waited ${ms}ms` };
}

/**
 * The client-side deadline sits this far above the one the kernel is given, per call: a fixed one
 * cut off captures that were asked to wait longer. It catches a kernel that never answers.
 */
const SNAPSHOT_CDP_MARGIN_MS = 5_000;
const SNAPSHOT_CDP_TIMEOUT_OVERRIDE = process.env.EMBIODY_SNAPSHOT_CDP_TIMEOUT_MS
  ? Number(process.env.EMBIODY_SNAPSHOT_CDP_TIMEOUT_MS)
  : undefined;
/** What takeSnapshots brings back: one tab failing is one item in failures, not a thrown batch. */
export interface SnapshotBatchResult {
  snapshots: TabSnapshot[];
  failures: TabSnapshotFailure[];
  /** Window-level popups (bubble/omnibox/menu/nativeDialog/systemMenu), filed by windowId. */
  windowPopups: Map<string, PopupInfo[]>;
  /** Popups held once for the whole browser (taskManager). */
  browserPopups: PopupInfo[];
}

/** A region no page reaches past. */
const WHOLE_PAGE = {
  topLeft: { x: -1_000_000, y: -1_000_000 },
  bottomRight: { x: 1_000_000, y: 1_000_000 },
};

export interface SnapshotRequest {
  windowId: string;
  tabId: string;
  /** The url/title read from the layout, handed to the model with the snapshot so it can confirm it is looking at the page it meant to. */
  url?: string;
  title?: string;
  /**
   * Read the page around this screen rather than the screen alone (longSnapshot, the
   * kernel's default region: 8000px above and below). The images stay one screen; the
   * elements off it come back marked `shown`, and can only be acted on by emsn.
   */
  long?: boolean;
  /**
   * Ask for the annotated picture (default true). Without one the browser answers in
   * milliseconds even for a minimized window, where a picture waits out the whole deadline.
   */
  image?: boolean;
  /** Read the whole page, not 8000px each way (implies long). */
  wholePage?: boolean;
  /** Ask for each link's address (returnHref). */
  href?: boolean;
}

/**
 * Capture a batch of tabs in one call (wrapping Embiody.browserTakeSnapshot): a targets tree in,
 * a windows[].tabs[] tree out, matched by position.
 *
 * The raw image follows SNAPSHOT_RETURN_IMAGE (on by default; config.ts says why). The annotated
 * image is asked for unless a target sets image: false, and either one makes the kernel take
 * the screenshot.
 *
 * Throws only when the reply cannot be matched to the request, or no target has a usable id; a
 * request the kernel refuses whole (a window or tab twice) is deduplicated here first.
 */
export async function takeSnapshots(
  cdp: CdpClient,
  params: {
    targets: SnapshotRequest[];
    /** A per-tab deadline; the configured value is used when absent. Reaching it is not a failure — see the note in config. */
    timeoutMs?: number;
    round?: number;
  },
): Promise<SnapshotBatchResult> {
  // A window may appear once and a tab may appear once, or the kernel refuses the **whole**
  // command (it has to hold "request and reply correspond position by position"). Deduplicate
  // here, so one slip upstream does not wipe out the entire batch.
  const byWindow = new Map<string, SnapshotRequest[]>();
  const seenTabs = new Set<string>();
  for (const t of params.targets) {
    const windowId = readId(t.windowId);
    const tabId = readId(t.tabId);
    if (!windowId || !tabId || seenTabs.has(tabId)) continue;
    seenTabs.add(tabId);
    const list = byWindow.get(windowId) ?? [];
    list.push({ ...t, windowId, tabId });
    byWindow.set(windowId, list);
  }
  const ordered = [...byWindow.entries()];
  if (ordered.length === 0) {
    throw new Error("browserTakeSnapshot has no usable windowId/tabId");
  }

  const payload = {
    targets: ordered.map(([windowId, tabs]) => ({
      windowId,
      tabs: tabs.map((t) => ({
        tabId: t.tabId,
        returnImage: t.image !== false && SNAPSHOT_RETURN_IMAGE,
        returnAnnotatedImage: t.image !== false,
        ...(t.long || t.wholePage ? { longSnapshot: true } : {}),
        ...(t.wholePage ? { longTopLeft: WHOLE_PAGE.topLeft, longBottomRight: WHOLE_PAGE.bottomRight } : {}),
        ...(t.href ? { returnHref: true } : {}),
      })),
    })),
    timeoutMs: params.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
  };

  const result: any = await cdp.sendCommand(
    "Embiody.browserTakeSnapshot",
    payload,
    SNAPSHOT_CDP_TIMEOUT_OVERRIDE ?? payload.timeoutMs + SNAPSHOT_CDP_MARGIN_MS,
  );

  const windows = Array.isArray(result?.windows) ? result.windows : [];
  if (windows.length !== ordered.length) {
    // The pdl promises windows[i] is targets[i]. If they do not line up we must not index by
    // position — the consequence of a shift is taking tab A's numbers for tab B's, with the
    // model then acting on a different page. Failing the whole batch is better.
    throw new Error(
      `browserTakeSnapshot returned ${windows.length} windows but ${ordered.length} were requested, so they cannot be matched positionally`,
    );
  }

  const snapshots: TabSnapshot[] = [];
  const failures: TabSnapshotFailure[] = [];
  const windowPopups = new Map<string, PopupInfo[]>();

  for (const [wi, [windowId, tabs]] of ordered.entries()) {
    const w = windows[wi] ?? {};
    windowPopups.set(windowId, readPopups(w.popups));
    const replyTabs = Array.isArray(w.tabs) ? w.tabs : [];
    if (replyTabs.length !== tabs.length) {
      throw new Error(
        `browserTakeSnapshot returned ${replyTabs.length} tabs for window ${windowId} but ${tabs.length} were requested, so they cannot be matched positionally`,
      );
    }
    for (const [ti, want] of tabs.entries()) {
      const r = replyTabs[ti] ?? {};
      // Check the id again on top of positional correspondence. A shift is far more dangerous than something missing, and the cost is one string comparison.
      const gotTab = readId(r.tabId);
      if (gotTab && gotTab !== want.tabId) {
        throw new Error(
          `browserTakeSnapshot item ${wi + 1}/${ti + 1} came back for tab ${gotTab}, but ${want.tabId} was requested`,
        );
      }
      const message =
        typeof r.message === "string" && r.message.trim()
          ? r.message.trim()
          : undefined;

      if (r.success === false) {
        failures.push({
          tabId: want.tabId,
          // The kernel is specific here (the renderer crashed / this batch was too large / the
          // tab is gone), and passing that straight to the model beats guessing again.
          reason: explainSnapshotFailure(want.tabId, message ?? "snapshot failed", readPopups(r.popups)),
          raw: message ?? "snapshot failed",
          pageType: readPageType(r),
        });
        continue;
      }

      if (SAVE_SNAPSHOTS) saveSnapshotArtifacts(r, params.round, want.tabId);

      // A snapshotId exists if and only if annotatedContent does (an invariant the pdl states).
      // Missing one means this batch of numbers does not exist at all — using it with
      // browserClick only buys "the element is not in the latest snapshot", when the truth is
      // that the batch was never issued. So treat it as a failure, carrying the kernel's note.
      const snapshotId = readId(r.snapshotId);
      const annotatedContent =
        typeof r.annotatedContent === "string" ? r.annotatedContent : "";
      if (!snapshotId || !annotatedContent) {
        failures.push({
          tabId: want.tabId,
          reason: `Tab ${want.tabId} got no element numbers this round${message ? `: ${message}` : " (the renderer did not produce annotations before the deadline)"}`,
          raw: message ?? "missing snapshotId",
          pageType: readPageType(r),
        });
        continue;
      }

      // An empty tree counts as a failure. Under heavy load the kernel "succeeds" with a
      // children:[] tree and a 5KB image of an undrawn page, and the 177 bytes of valid JSON slip
      // past the !annotatedContent check above. Letting it through breaks two gates at once: the
      // model gets a zero-line list, and the executor's number gate checks allowed.size and lets
      // everything through when the list is empty.
      //
      // The message says which kind of empty it is: genuinely no content (never
      // navigated / about:blank) is deterministic, everything else is worth one recapture — a 0KB
      // page measurably came back at 17KB.
      if (isEmptyAnnotatedTree(annotatedContent)) {
        failures.push({
          tabId: want.tabId,
          reason: explainEmptySnapshot(want.tabId, message),
          // Carry the kernel's own words so isDeterministicSnapshotFailure can classify it.
          raw: message ?? "empty element list",
          pageType: readPageType(r),
        });
        continue;
      }

      // No picture is not a failure: the browser says so when a window is off the screen, and
      // the numbers were read from the page just now. Its message then explains the missing
      // picture, and is not the "captured while still loading" note it is otherwise.
      const annotatedImage = r.annotatedImage
        ? ensureBase64(r.annotatedImage, "annotatedImage")
        : undefined;
      const noImageReason =
        !annotatedImage && want.image !== false
          ? (message ?? "the browser returned no picture")
          : undefined;

      snapshots.push({
        windowId: want.windowId,
        tabId: want.tabId,
        snapshotId,
        // The entry's own url over the one the caller passed in: the caller's came from a
        // browserGetWindowInfo read before the capture, and a navigation that ended in a
        // download or a 204, or a redirect, leaves the tab somewhere else.
        url: readEntryUrl(r) ?? want.url ?? "",
        title: want.title ?? "",
        pageType: readPageType(r),
        annotatedImage,
        noImageReason,
        // The raw image is optional: with snapshot.returnImage off the kernel does not capture it at all.
        image: typeof r.image === "string" && r.image ? r.image : undefined,
        annotatedContent,
        rendered: renderAnnotatedContent(annotatedContent),
        position: renderPagePosition(annotatedContent),
        emsnLines: collectEmsnLines(annotatedContent),
        popups: readPopups(r.popups),
        elapsedMs:
          typeof r.elapsedMs === "number" && Number.isFinite(r.elapsedMs)
            ? r.elapsedMs
            : undefined,
        loadingMessage: annotatedImage ? message : undefined,
      });
    }
  }

  return {
    snapshots,
    failures,
    windowPopups,
    browserPopups: readPopups(result?.browserPopups),
  };
}

/**
 * Capture one tab. A single-target wrapper around takeSnapshots, for callers that care about
 * one tab. It throws when that item fails — a single-target caller has no "but the other items
 * succeeded".
 */
export async function takeSnapshot(
  cdp: CdpClient,
  params: {
    windowId?: string;
    tabId?: string;
    url?: string;
    title?: string;
    timeoutMs?: number;
    round?: number;
    long?: boolean;
    image?: boolean;
  },
): Promise<TabSnapshot> {
  const target = requireTarget("browserTakeSnapshot", params);
  if (isTargetError(target)) {
    throw new Error(target.error);
  }
  const batch = await takeSnapshots(cdp, {
    targets: [
      {
        windowId: target.windowId,
        tabId: target.tabId,
        url: params.url,
        title: params.title,
        long: params.long,
        image: params.image,
      },
    ],
    timeoutMs: params.timeoutMs,
    round: params.round,
  });
  const shot = batch.snapshots[0];
  if (!shot) {
    throw new Error(batch.failures[0]?.reason ?? "page snapshot failed");
  }
  return shot;
}

/**
 * Whether this annotatedContent is an empty tree.
 *
 * **The test is whether the list rendered for the model is empty**, not whether the tree has
 * any `children`. The latter is a structural proxy that does not match: a tree of nothing but
 * empty containers, or nothing but regions, or elements carrying no text at all, has
 * children.length above 0 and still renders empty — and letting it through is the
 * two-gates-at-once failure described in takeSnapshots.
 *
 * Something that will not parse is **not** empty: when parsing fails the renderer hands the
 * content to the model unchanged (deliberately — verbose beats blank), and that content is
 * still useful and should not be treated as a capture failure and recaptured. Content returned
 * unchanged is non-empty, so this naturally judges it non-empty.
 */
export function isEmptyAnnotatedTree(annotatedContent: string): boolean {
  return renderAnnotatedContent(annotatedContent).trim() === "";
}

/** The url of one snapshot entry, absent when the browser had no tab left to read it from. */
function readEntryUrl(entry: any): string | undefined {
  return typeof entry?.url === "string" && entry.url ? entry.url : undefined;
}

/** The pageType of one snapshot entry, absent for the same reason. */
function readPageType(entry: any): string | undefined {
  return typeof entry?.pageType === "string" && entry.pageType
    ? entry.pageType
    : undefined;
}

/**
 * What a non-normal pageType means for the caller, or undefined when there is nothing to say.
 *
 * Without this all four kinds look alike — a snapshot came back — and three of them make the
 * obvious next move useless: reading a PDF's text out of a reply that never carries it,
 * treating the browser's own error page as the site's content, clicking numbers that went with
 * a dead renderer.
 */
export function describePageType(pageType: string | undefined): string | undefined {
  switch (pageType) {
    case "plugin":
      return (
        "This is a PDF. Only the viewer's own controls are numbered — the document's text and " +
        "its form fields are not in this reply and no further snapshot will have them. Download " +
        "it or open the source elsewhere to read it."
      );
    case "error":
      return (
        "This is the browser's own error page, not the site's: the site's content never " +
        "arrived. The machine-readable reason (ERR_CONNECTION_REFUSED, HTTP ERROR 404, " +
        "NET::ERR_CERT_AUTHORITY_INVALID and the like) is in the text below — read it there."
      );
    case "crashed":
      return (
        "This tab's renderer is gone (the \"Aw, Snap\" page). Any numbers here name elements " +
        "that went with it, so clicking or typing will not reach them. Reload the page and " +
        "photograph it again."
      );
    default:
      return undefined;
  }
}

/**
 * Whether recapturing this tab is pointless. Two independent signals: the kernel's own message,
 * and a pageType saying the page itself is not coming back this way.
 */
export function snapshotRetryIsPointless(failure: {
  raw?: string;
  reason: string;
  pageType?: string;
}): boolean {
  if (failure.pageType === "error" || failure.pageType === "crashed") {
    return true;
  }
  return isDeterministicSnapshotFailure(failure.raw ?? failure.reason);
}

/**
 * Whether a capture failure means "trying again changes nothing". Retrying these only wastes
 * two seconds, and what the model needs to be told is entirely different.
 *
 * "Failed to capture html" should no longer appear on browsers since September 2026 (the kernel now returns an empty
 * but valid snapshot); this entry stays as a defence, so behaviour is still right against an
 * older build.
 */
export function isDeterministicSnapshotFailure(message: string): boolean {
  // "renderer is gone / crashed": the kernel's own prescription is "reload the page and capture
  // again", not "capture again"; retrying delays that sentence reaching the model by a round.
  // **Every empty reply states for itself whether recapturing helps**: the ones
  // that will not help carry "Another snapshot will say the same.", and the ones that will
  // carry "snapshot it again". So this matches that sentence rather than specific page states —
  // if they add other "recapturing is useless" cases later, carrying the same sentence
  // classifies them correctly with no new branch here.
  return /Failed to capture html|No Tab found|missing required parameter|missing snapshotId|snapshot is missing|renderer is gone|page crashed|will say the same/i.test(
    message,
  );
}

/**
 * Translate an empty snapshot into something the model can change approach on. The kernel's
 * message says which kind of empty it is: about:blank needs a navigation first, a page not
 * drawn yet needs a recapture.
 */
export function explainEmptySnapshot(
  tabId: string,
  message: string | undefined,
): string {
  // Only this one needs wording of its own: it asks the model to navigate rather than wait for
  // the page to finish drawing.
  // (The kernel also has "This tab has not been navigated yet", a fallback they could not name
  //  a flow reaching and explicitly said not to branch on; if it ever appears it falls through
  //  to "not drawn yet" below, at the cost of one wasted recapture.)
  if (message && /is about:blank/i.test(message)) {
    return `Tab ${tabId} is a blank page (about:blank) with nothing to act on. Give it an address with browserNavigate before looking at it again`;
  }
  return `Tab ${tabId} came back with an empty element list this round. The page has most likely not rendered yet, which happens when the machine is busy, so leave it alone this round`;
}

/** Translate a kernel capture error into something the model can change approach on. */
export function explainSnapshotFailure(tabId: string, message: string, popups: PopupInfo[] = []): string {
  if (/Failed to capture html/i.test(message)) {
    // Only an older build reaches here (since September 2026 the kernel returns an empty snapshot for an empty document rather than an error).
    return `Tab ${tabId} has nothing to capture, possibly a blank page. Give it an address with browserNavigate before looking at it again`;
  }
  // A parameter of the wrong type or a missing one ("Invalid parameters"; an unknown name has
  // its own message since late October 2026, which falls through to the end as is). Almost always a
  // version mismatch: the protocol changed shape and one side did not follow. We were caught by
  // it once: the source had followed the batch snapshot change while dist was two days behind.
  if (/Invalid parameters/i.test(message)) {
    return `Snapshot of tab ${tabId} failed: the kernel rejected the parameters (${message}). This is almost always a protocol shape mismatch rather than a page problem. Check that dist is freshly built (npm run build) and that the browser build matches the pdl version this project targets`;
  }
  if (/No Tab found/i.test(message)) {
    return `Tab ${tabId} no longer exists, possibly closed. Pick one of the tabs listed in this round layout`;
  }
  // A failed entry lists what holds the page in its popups (an alert, "Leave site?"); pass them on.
  const held = popups.length > 0 ? ` popups blocking this tab: ${JSON.stringify(popups)}` : "";
  return `Snapshot of tab ${tabId} failed: ${message}${held}`;
}

function saveSnapshotArtifacts(
  result: any,
  round?: number,
  tabId?: string,
): void {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const roundPart = round !== undefined ? `_round${round}` : "";
    // Include the tabId: a round may capture several tabs, and without it they overwrite each other.
    const tabPart = tabId ? `_tab${tabId}` : "";
    const prefix = path.join(SNAPSHOT_DIR, `${timestamp}${roundPart}${tabPart}`);

    // image is present when SNAPSHOT_RETURN_IMAGE asked for it.
    if (result.image) {
      const buf = Buffer.isBuffer(result.image)
        ? result.image
        : Buffer.from(result.image, "base64");
      fs.writeFileSync(`${prefix}_snapshot.png`, buf);
    }
    if (result.annotatedImage) {
      const buf = Buffer.isBuffer(result.annotatedImage)
        ? result.annotatedImage
        : Buffer.from(result.annotatedImage, "base64");
      fs.writeFileSync(`${prefix}_annotated.png`, buf);
    }
    if (result.annotatedContent) {
      const text =
        typeof result.annotatedContent === "object"
          ? JSON.stringify(result.annotatedContent, null, 2)
          : String(result.annotatedContent);
      fs.writeFileSync(`${prefix}_content.json`, text);
    }
  } catch (e) {
    void appendDebugLog(
      "browser_actions",
      "failed to write snapshot to disk",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function ensureBase64(value: unknown, fieldName: string): string {
  if (!value) {
    throw new Error(`snapshot is missing ${fieldName}`);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  throw new Error(`${fieldName} is not valid image data`);
}
