import { z } from "zod";
import type { CoverageSummary } from "./read_coverage.js";

export const RuntimeActionNameSchema = z.enum([
  "browserNavigate",
  "browserGoBack",
  "browserGoForward",
  "browserReload",
  "browserStopLoading",
  "browserClick",
  "browserInputText",
  "browserPressKey",
  "browserSelectEditableText",
  "browserScroll",
  "browserMove",
  "browserDrag",
  "browserClosePopupBubble",
  "browserSetAudioMuted",
  "browserCloseTab",
  "browserNewWindow",
  "browserAddNewTab",
  "browserCloseWindow",
  "browserStartHumanControl",
  "browserStopHumanControl",
  "browserWait",
  // The one action that never reaches the browser: the runtime answers it from the task history page records.
  "queryHistoryPage",
]);

/**
 * Actions the runtime answers itself and never sends to the browser.
 * The contract test uses this to exclude them from "every action must map to an Embiody command".
 */
export const RUNTIME_ANSWERED_ACTIONS: ReadonlySet<string> = new Set([
  "queryHistoryPage",
]);

/**
 * After this action runs, the batch must stop and observe again. Two reasons:
 *
 * 1. **The page changed** (navigate / goBack / goForward / reload / newTab / newWindow): every
 *    emsn in the snapshot the batch was planned against is void. A stale emsn fails hard rather
 *    than clicking the wrong thing, but there is no reason to send one that is bound to fail.
 * 2. **A tab stopped existing or changed hands** (closeTab / closeWindow / startHumanControl):
 *    what the later actions act on is gone, or no longer belongs to the agent.
 *
 * Everything else can carry on; the typical useful batch is "fill a few fields then submit".
 *
 * Note that "this action may change the page" is **not** a reason: click and inputText change it
 * constantly and still carry on, because the snapshot's numbers stay valid and the kernel hard
 * fails an element that has gone rather than acting on the wrong one. The same goes for move and
 * drag, which are usually one step of several (walking the pointer along a menu path, pushing a
 * slider over in stages). What they cannot do inside one batch is act on something that only
 * **appeared** because of them — a newly opened menu carries no numbers until the next snapshot.
 */
export function isBatchTerminatingAction(fn: RuntimeActionName): boolean {
  switch (fn) {
    case "browserNavigate":
    case "browserGoBack":
    case "browserGoForward":
    case "browserReload":
    case "browserAddNewTab":
    case "browserNewWindow":
    case "browserCloseTab":
    case "browserCloseWindow":
    case "browserStartHumanControl":
      return true;
    default:
      return false;
  }
}

/**
 * Drop the redundant click in "click this box, then type into this box".
 *
 * browserInputText focuses its target by itself, so the click was never needed; and for an
 * input that **opens a panel when clicked** (a date field being the classic) it is harmful:
 * the click opens the calendar, the calendar takes focus, and the typing that follows finds
 * nothing that can hold text, so the kernel reports "this is not an input" — measured, three
 * wasted attempts in a single round.
 *
 * Only an **immediately adjacent** pair is recognised (click(X) followed directly by
 * inputText(X)). With anything in between, leave it alone: "open something -> do something
 * else -> come back and type" is a legitimate batch, and where the intent is unclear we
 * should not change the model's mind for it. The pair must also name the same tab: each tab
 * numbers its elements on its own.
 */
export function dropRedundantFocusClicks(
  batch: RuntimeActionCall[],
): { batch: RuntimeActionCall[]; dropped: string[] } {
  const read = (c: RuntimeActionCall | undefined, key: "emsn" | "tabId"): string | undefined => {
    const raw = (c?.params as Record<string, unknown> | undefined)?.[key];
    if (raw === undefined || raw === null) return undefined;
    const v = String(raw).trim();
    return v && v !== "undefined" && v !== "null" ? v : undefined;
  };
  const kept: RuntimeActionCall[] = [];
  const dropped: string[] = [];
  for (const [i, call] of batch.entries()) {
    const next = batch[i + 1];
    const id = read(call, "emsn");
    if (
      call.function === "browserClick" &&
      next?.function === "browserInputText" &&
      id !== undefined &&
      id === read(next, "emsn") &&
      read(call, "tabId") === read(next, "tabId")
    ) {
      dropped.push(id);
      continue;
    }
    kept.push(call);
  }
  return { batch: kept, dropped };
}

export const RuntimeActionCallSchema = z.object({
  function: RuntimeActionNameSchema,
  // Left out on an action that takes none (browserGoBack): read as no parameters, not a voided plan.
  params: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The actions to run this round, **executed front to back in array order**.
 *
 * There is only this field (no singular action_call): one action is written as a
 * single-element array. Two fields doing the same job are a long-term liability, so the
 * contract keeps only the array shape.
 *
 * Parsing is forgiving — a bare object from the model (rather than an array) is wrapped into
 * a single-element array. That is normalisation, not a second contract: the prompt and the
 * schema documentation only mention action_calls.
 */
export const RuntimeActionCallsSchema = z
  .union([z.array(RuntimeActionCallSchema), RuntimeActionCallSchema])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const list = Array.isArray(v) ? v : [v];
    return list.length ? list : undefined;
  });

export const RuntimeExecutingStepSchema = z.object({
  path: z.string(),
  description: z.string(),
  status: z.enum(["completed", "partial", "failed"]),
  result: z.string(),
});

/**
 * The tabs to snapshot next round. The model names them and the runtime captures that list
 * (concurrently).
 *
 * Absent, null or empty -> the runtime picks one by its fallback order and says outright, in the
 * observation, that it chose on the model's behalf. A tabId in the list must appear in **this
 * round's layout**; an invented id is refused and reported back rather than sent to the kernel
 * in exchange for "No Tab found".
 */
export const SnapshotTabsSchema = z
  .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === undefined || v === null) return undefined;
    const list = Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const raw of list) {
      const id = String(raw ?? "").trim();
      // Deduplicate: naming the same tab twice should not buy two identical images.
      if (id && !out.includes(id)) out.push(id);
    }
    return out.length ? out : undefined;
  });

export const RuntimeNextStepDetailSchema = z.object({
  path: z.string(),
  description: z.string(),
  /**
   * Always "[NEXT STEP]" — a marker for lining up with the plain-text tree in
   * task_tree_overview, carrying **no information of its own** ("this is the next step" is
   * already said by the fact that it sits in next_step_detail), and no code in the repository
   * reads it.
   *
   * So this is **normalised rather than validated**: validating it would let the model writing
   * something like "executing" void the whole plan and cost a resent round, in exchange for zero
   * information. Whatever arrives (or nothing) is taken as the one legal value.
   *
   * WARNING only a zero-information field can be treated this way. is_paused / path / emsn
   * change behaviour when wrong and must still be refused and retried — correctness is not
   * traded for smoothness.
   */
  status: z.any().transform(() => "[NEXT STEP]" as const),
  is_paused: z.boolean(),
  /**
   * This pause came from the runtime intercepting something (the model wrote a bad action
   * name), not from the model genuinely wanting a person.
   *
   * **The model never fills this field**; only the runtime writes it (interceptObserveAction).
   * A boolean, so control information is not buried in prose.
   */
  intercepted: z.boolean().optional(),
  /**
   * This pause is "a person has to do this step" (sign-in, payment, a captcha), not the model
   * being unsure. **The model never fills this field**; only the runtime writes it.
   *
   * The two finish differently: a step needing a person finishes as a normal pause and hands the
   * target back for resuming; the model asking for one throws and terminates.
   *
   * A boolean rather than a test on the description: control flow hanging off prose breaks
   * when the wording improves.
   */
  sensitive: z.boolean().optional(),
  /**
   * What the pause needs a person for: answering a question, or acting on the page.
   * **The model fills this one itself.**
   *
   * The runtime must know, because the handling differs (whether to hand the tab over) and it
   * cannot tell from the prose in description — see the note on `sensitive`.
   *
   * Missing or unrecognised values default to needs_human_on_page. Handing over needlessly costs
   * two CDP calls; not handing over when it was needed leaves a person asked to work a page with
   * no working keyboard — a dead end. The expensive side is the recoverable one.
   */
  pause_kind: z.any().optional().transform(normalizePauseKind),
  action_calls: RuntimeActionCallsSchema,
  snapshot_tabs: SnapshotTabsSchema,
  /**
   * Next round's capture reads the page around the screen, not the screen alone (pdl
   * longSnapshot), for every tab captured. One round only. A string "true" counts: models write
   * booleans as strings, and dropping the request silently would leave it searching one screen.
   */
  read_whole_page: z.preprocess(
    (v) => v === true || (typeof v === "string" && v.trim().toLowerCase() === "true") || undefined,
    z.boolean().optional(),
  ),
});

export const RuntimePlanSchema = z.object({
  /**
   * The plain-text task tree. **A literal `\n` is normalised into a real newline**: nano
   * measurably writes newlines as `\\n` (two characters), so the whole tree becomes one line
   * with no node boundaries and collapsing silently stops working. The prompt already says to
   * escape only one level; this is a second net — and the conversion is risk-free, since
   * nobody writing a task tree means a literal backslash-n.
   */
  task_tree_overview: z
    .string()
    .transform((tree) => tree.replace(/\\n/g, "\n")),
  /**
   * The model's summary of the **whole current page**, for the task history page records.
   * Optional, unvalidated, and harmless when missing — it is only a hint for its future self
   * ("this page has parts I have not seen") and takes part in no control flow.
   */
  page_abstract: z
    .any()
    .optional()
    .transform((v) =>
      typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined,
    ),
  current_executing_step: RuntimeExecutingStepSchema,
  next_step_detail: RuntimeNextStepDetailSchema,
  all_task_is_complete: z.boolean(),
  complete_reason: z.string().optional().default(""),
});

export type RuntimeActionName = z.infer<typeof RuntimeActionNameSchema>;
export type RuntimeActionCall = z.infer<typeof RuntimeActionCallSchema>;
export type RuntimeExecutingStep = z.infer<typeof RuntimeExecutingStepSchema>;
export type RuntimeNextStepDetail = z.infer<typeof RuntimeNextStepDetailSchema>;
export type RuntimePlan = z.infer<typeof RuntimePlanSchema>;

/**
 * A popup currently open on a tab (or on the window it belongs to); matches the pdl's PopupInfo.
 *
 * browserTakeSnapshot hands this over as "what is in the way on the page", so the model need
 * not infer it after the fact from "click failed: obscured".
 */
export interface PopupInfo {
  /**
   * One of permission / bubble / modalDialog / omnibox / nativeDialog / menu / systemMenu /
   * taskManager / beforeUnload.
   */
  type: string;
  /** The popup's text, only when Chromium provides structured text (permission popups only). */
  message?: string;
  /** The popup's title, likewise only when the layer below gives one (some bubbles have no title). */
  title?: string;
  /**
   * Which actions browserClosePopupBubble accepts for **this** popup.
   * permission takes allowOnce/allow/deny/dismiss/ignore (allowOnce appears only on
   * permissions that really have session-scoped grants, which today means geolocation);
   * beforeUnload accepts none (it is the person's to answer); every other type accepts dismiss only.
   */
  availableActions: string[];
}

/** One tab (matching TabInfo in embiody_protocol.pdl). */
export interface TabInfo {
  tabId: string;
  index: number;
  title: string;
  url: string;
  isForeground: boolean;
  isAgentTab: boolean;
  /** Whether browserGoBack will do anything: false means there is no earlier history entry and calling it must fail. */
  canGoBack: boolean;
  /** Likewise for browserGoForward; only true after going back at least once. */
  canGoForward: boolean;
  isMuted: boolean;
  /** Whether the page is making sound right now. A muted tab that is still playing is still true here. */
  isAudible: boolean;
}

/** One browser window and its tabs (matching WindowInfo in embiody_protocol.pdl). */
export interface WindowInfo {
  windowId: string;
  index: number;
  title: string;
  isHidden: boolean;
  /** One of "minimized" | "fullscreen" | "maximized" | "normal". */
  windowState: string;
  hasAgentTab: boolean;
  tabs: TabInfo[];
}

/**
 * One tab's snapshot: the annotated image, the raw image, annotatedContent and this batch's
 * snapshotId — all one set.
 *
 * **The authority on numbers is annotatedContent, not the annotated image.** The image draws
 * only some of them: one snapshot of Ctrip's home page had 138 emsn in annotatedContent while
 * the big orange Search button (emsn 66) carried no label at all. The image answers "which
 * one"; annotatedContent answers "what is its number".
 */
export interface TabSnapshot {
  windowId: string;
  tabId: string;
  /**
   * The id of this snapshot, "<page id>-<n>". **Required by every element action** (click,
   * inputText, pressKey, selectEditableText, move, drag; scroll when it names a pane).
   *
   * An element keeps its emsn across the snapshots of a page, so with an emsn any snapshot of
   * the current page is accepted and a number whose element is gone is refused; with
   * coordinates only the latest one is. A navigation or reload starts a new page.
   */
  snapshotId: string;
  /**
   * Where the tab was at capture time, as the snapshot entry itself reports it.
   *
   * Not the address the caller asked for: a navigation ending in a download or a 204 leaves the
   * tab on the page it was already showing, and a redirect lands somewhere else again. The
   * layout read before the capture can therefore name a different page than the one photographed.
   */
  url: string;
  title: string;
  /**
   * What kind of page was photographed: normal / error / plugin / crashed.
   *
   * Deliberately a plain string — the kernel may add values, and a union type here would refuse
   * a page the browser can already show. Only the three non-normal ones are acted on; see
   * describePageType.
   */
  pageType?: string;
  /**
   * The annotated image (pdl: annotatedImage).
   *
   * Absent when none was asked for, or when the browser could not get a picture in time: a
   * window off the screen (minimized) paints nothing for a page it navigated to meanwhile.
   * The element numbers are good either way; noImageReason carries the browser's words.
   */
  annotatedImage?: string;
  /** Why a requested picture is missing, in the browser's words. */
  noImageReason?: string;
  /**
   * The raw image (pdl: image). Present only when snapshot.returnImage is on; see
   * SNAPSHOT_RETURN_IMAGE in config.ts for why the annotated image alone is not enough.
   */
  image?: string;
  annotatedContent: string;
  /**
   * annotatedContent rendered into the flat text a model reads (see annotated_content.ts), and
   * the one-line page position above it. Rendered once here so the task loop and the thin tools
   * show a model the same thing: raw JSON is several times larger, carries no position line,
   * and has emsn as strings where the actions take integers.
   */
  rendered: string;
  position: string;
  /**
   * The popups open on **this tab itself** at capture time: permission, modalDialog and
   * beforeUnload.
   *
   * Popups are scoped in three layers. Menus, the address bar dropdown and
   * toolbar bubbles belong to the **window** and live in RuntimeObservation.windowPopups; the
   * task manager belongs to the **whole browser** and lives in browserPopups. Reporting a
   * window's menu on a tab tells a falsehood about every tab in that window.
   */
  popups: PopupInfo[];
  /** How long this item took from command arrival to data ready (including time queued behind other items' PNG encoding). */
  elapsedMs?: number;
  /**
   * Every emsn **shown to the model** this round, used to block a number we never showed.
   *
   * The kernel only validates that a number belongs to this batch; its table holds more numbers
   * than annotatedContent renders, so an unshown number is still clicked. See the guard in
   * runtime_executor.ts for the case this cost us.
   */
  emsnLines?: ReadonlyMap<string, string>;
  /**
   * The kernel's note for "the deadline passed while the page was still loading, so I captured
   * anyway". When present it must reach the model: the image it is looking at may be half-built.
   */
  loadingMessage?: string;
}

/** A tab that could not be captured. A soft failure: tell the model why so it can change approach, rather than losing the whole round. */
export interface TabSnapshotFailure {
  tabId: string;
  /** The wording for the model: already phrased so it can act on it. */
  reason: string;
  /**
   * The kernel's own words, used only to judge "is this worth retrying".
   *
   * reason cannot be used for that: reason is translated ("No Tab found" becomes "the tab no
   * longer exists"), while isDeterministicSnapshotFailure matches the kernel's original text.
   * Matching a translation against the original means a deterministic failure is taken for a
   * transient one and retried for nothing — which is measurably what happened.
   */
  raw?: string;
  /**
   * The entry's pageType, when the kernel could still read it off a failed tab. A crashed or
   * error page is a second reason recapturing is pointless, independent of the message text.
   */
  pageType?: string;
}

/**
 * Everything one round of observation produces.
 *
 * layout is refetched unconditionally every round (browserGetWindowInfo costs about 1ms). It
 * cannot be updated only "after we touched a tab ourselves" — pages open tabs on their own
 * (window.open, target=_blank), which happens outside any action, and updating after the fact
 * is bound to miss it.
 */
export interface RuntimeObservation {
  layout: WindowInfo[];
  snapshots: TabSnapshot[];
  failures: TabSnapshotFailure[];
  /**
   * Window-level popups, filed by windowId: bubble, omnibox, nativeDialog, menu, systemMenu.
   * Reported once per window regardless of how many of its tabs were captured this round — a
   * menu is the window's menu.
   */
  windowPopups: Map<string, PopupInfo[]>;
  /** Browser-level popups (taskManager). One set for the whole browser. */
  browserPopups: PopupInfo[];
  /** The list was chosen by the runtime on the model's behalf (it named nothing, or nothing it named was usable). */
  chosenByRuntime: boolean;
  /** The reason for choosing, passed to the model verbatim — do not let it think it chose. */
  chosenReason?: string;
}

/** How many tabs one round may capture. Anything beyond is dropped, and the model is told. */
export const MAX_SNAPSHOT_TABS = 20;

/** One capturable target: a tab always belongs to a window, so both ids travel together. */
export interface SnapshotTarget {
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  /** Whether the agent is using this tab; preferred when falling back to a choice. */
  isAgentTab: boolean;
  /** Whether this is the tab its window is currently showing. */
  isForeground: boolean;
}

export interface ResolvedSnapshotTabs {
  tabs: SnapshotTarget[];
  /** The list was decided by the runtime (the model named nothing, or nothing it named was usable). */
  chosenByRuntime: boolean;
  chosenReason?: string;
  /** Tabs the model named that are not in the layout, reported back — change it silently and it will make the same mistake next round. */
  rejected: TabSnapshotFailure[];
  /** The note for when the list was truncated at the cap. */
  truncatedNote?: string;
}

/**
 * A snapshot of this address would yield nothing useful: about:blank and an empty url only.
 *
 * **chrome://newtab is deliberately not included** — measurably it captures fine (131-327ms, a
 * 37-53KB annotated image, 6 emsn), so calling it uncapturable would be untrue and would block a
 * legitimate wish to look at the new tab page.
 *
 * The kernel does capture a blank page (as a valid empty snapshot); it is blocked because that
 * carries no information the layout does not already give.
 *
 * "Loading, no content yet" cannot be told from the address and is not guessed at — let it be
 * captured, and the kernel says in its message that loading had not finished.
 */
function isUncapturableUrl(url: string): boolean {
  const u = (url ?? "").trim().toLowerCase();
  return u === "" || u === "about:blank";
}

/**
 * Nobody is using this tab, so the agent can safely take it as its working target.
 * A different question from isUncapturableUrl: a new tab page can be captured, and it is also
 * a page nobody is using.
 */
function isIdleUrl(url: string): boolean {
  const u = (url ?? "").trim().toLowerCase();
  return (
    isUncapturableUrl(u) ||
    u.startsWith("chrome://newtab") ||
    u.startsWith("chrome://new-tab-page")
  );
}

function flattenTabs(layout: WindowInfo[]): SnapshotTarget[] {
  return layout.flatMap((win) =>
    win.tabs
      .filter((tab) => win.windowId && tab.tabId)
      .map((tab) => ({
        windowId: win.windowId,
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        isAgentTab: tab.isAgentTab,
        isForeground: tab.isForeground,
      })),
  );
}

/**
 * Why this tab is not worth capturing, phrased for the model, or null. Only a blank page: its
 * url already says everything. Agent-tab and foreground state do not matter.
 */
export function snapshotBlockedReason(tab: { tabId: string; url: string }): string | null {
  if (isUncapturableUrl(tab.url)) {
    return `Tab ${tab.tabId} is a blank page (${tab.url || "about:blank"}) with no elements to act on; capturing it would only yield a blank image. Give it an address with browserNavigate before looking at it again`;
  }
  return null;
}

/**
 * Decide which tabs this round actually captures.
 *
 * Order: the tabs the model named (validated against this round's layout) -> fall back when
 * none are valid. The fallback order: last round's working target if it still exists; else a
 * agent tab; else a non-blank page; else the first.
 *
 * Both points are deliberate:
 * - An invented tabId is stopped here rather than sent to the kernel for a "No Tab found" —
 *   that sentence guides the model nowhere, while "the X you named is not in this round's
 *   layout; the ones that exist are A/B/C" does.
 * - Choosing on the model's behalf must be said out loud. Change the list silently and it will
 *   make the same mistake next round.
 */
export function resolveSnapshotTabs(input: {
  requested?: string[];
  layout: WindowInfo[];
  target?: { windowId: string; tabId: string };
}): ResolvedSnapshotTabs {
  const all = flattenTabs(input.layout);
  const byId = new Map(all.map((t) => [t.tabId, t]));
  const rejected: TabSnapshotFailure[] = [];

  const picked: SnapshotTarget[] = [];
  for (const id of input.requested ?? []) {
    const found = byId.get(id);
    if (found) {
      picked.push(found);
    } else {
      rejected.push({
        tabId: id,
        reason: `tabId ${id} is not in this round layout (it may have been closed, or the id was invented). Tabs that exist this round: ${all.map((t) => t.tabId).join(", ") || "none"}`,
      });
    }
  }

  const truncate = (tabs: SnapshotTarget[]): {
    tabs: SnapshotTarget[];
    note?: string;
  } => {
    if (tabs.length <= MAX_SNAPSHOT_TABS) return { tabs };
    const dropped = tabs.length - MAX_SNAPSHOT_TABS;
    return {
      tabs: tabs.slice(0, MAX_SNAPSHOT_TABS),
      note: `At most ${MAX_SNAPSHOT_TABS} tabs are captured per round; you named ${tabs.length}, so the last ${dropped} were not captured this round`,
    };
  };

  if (picked.length) {
    const { tabs, note } = truncate(picked);
    return { tabs, chosenByRuntime: false, rejected, truncatedNote: note };
  }

  // Falling back. Distinguish "named nothing" from "everything named was invalid" — the model is told different things.
  const reasonPrefix =
    input.requested?.length
      ? "None of the tabs you named are in this round layout"
      : "You did not specify snapshot_tabs";

  const target = input.target && byId.get(input.target.tabId);
  if (target) {
    return {
      tabs: [target],
      chosenByRuntime: true,
      chosenReason: `${reasonPrefix}, so the runtime used the previous working tab ${target.tabId}`,
      rejected,
    };
  }

  const targetGone = !!input.target && !byId.get(input.target.tabId);
  const agentTab = all.find((t) => t.isAgentTab);
  const nonBlank = all.find((t) => !isIdleUrl(t.url));
  const fallback = agentTab ?? nonBlank ?? all[0];

  if (!fallback) {
    return {
      tabs: [],
      chosenByRuntime: true,
      chosenReason: `${reasonPrefix}, and this round layout holds no tab at all`,
      rejected,
    };
  }

  const how = agentTab
    ? "picked a tab the agent is already using (isAgentTab)"
    : nonBlank
      ? "picked a tab that is not a blank page"
      : "only blank pages were left, so it picked the first";
  const gone = targetGone
    ? `the previous working tab ${input.target!.tabId} is gone, so `
    : "";
  return {
    tabs: [fallback],
    chosenByRuntime: true,
    chosenReason: `${reasonPrefix}; ${gone}the runtime ${how}: ${fallback.tabId}`,
    rejected,
  };
}

/**
 * One task history page record: what this task saw at a given URL.
 *
 * **Only the model's own one-line summary is stored, never an element list.** An element-level
 * archive is voided by the next longSnapshot (one command re-reads the whole page), while
 * "roughly what this page was, and what I have not looked at" cannot be recovered — once we
 * have left the page, nothing can reconstruct it short of navigating back.
 */
export interface RuntimePageRecord {
  url: string;
  title: string;
  /** The model's whole-page summary (page_abstract). An empty string until it writes one. */
  abstract: string;
  /** The round it was first reached, used only to order the history list on a timeline. */
  firstRound: number;
  /** The round it was last reached: how stale the summary is, and the basis for eviction. */
  lastRound: number;
  /**
   * Which parts of it the model has seen, per scrolling area (see read_coverage.ts). Absent
   * until a snapshot carries the position fields (newer browsers).
   */
  coverage?: CoverageSummary[];
}

export interface RuntimeHistoryEntry {
  round: number;
  path: string;
  description: string;
  status: RuntimeExecutingStep["status"];
  result: string;
}

export interface RuntimeContextState {
  taskTreeOverview: string;
  history: RuntimeHistoryEntry[];
  latestWindowId?: string;
  latestTabId?: string;
  currentDescriptionEx: string;
  /**
   * How many rounds in a row the same "next step" appeared **with the page unchanged by a
   * single character** throughout. For the rule and why it is tied to the page, see
   * BrowserRuntimeMemory.targetRepeatIfAdopted.
   */
  consecutiveSameTargetCount: number;
  latestTargetPath?: string;
  /** Whether the working tab's annotatedContent is byte-for-byte the same as last round. */
  pageUnchanged: boolean;
  /**
   * Questions the human has answered. **Fed to the model every round**: given once on the
   * round the answer arrives, it is forgotten by the next and the model goes back to doing what
   * the user already ruled out.
   */
  humanAnswers: Array<{ question: string; answer: string }>;
  /** The task history page records, in order of first arrival. */
  pages: RuntimePageRecord[];
  /** Which page the working tab is on this round (undefined when it was not captured). page_abstract is filed against it. */
  currentPageUrl?: string;
}

export interface RuntimeVllmRequest {
  /**
   * The round number. Used only to name the prompt/reply files written to disk (see
   * promptDumpName).
   */
  round?: number;
  userTask: string;
  currentDescriptionEx: string;
  /** The first planning-only round passes no observation, and decide runs in its no-screenshot planning mode. */
  observation?: RuntimeObservation;
  /** The current working target: the default subject when the model names no tab to capture. */
  target?: { windowId: string; tabId: string };
  state: RuntimeContextState;
}

export interface RuntimeEvent {
  type: "step_update" | "complete";
  round: number;
  stage: "bootstrap" | "observe" | "decide" | "act" | "complete";
  message: string;
  plan?: RuntimePlan;
  executionResult?: string;
}

export interface BrowserRunTaskArgs {
  task: string;
  windowId?: string;
  tabId?: string;
  maxRounds?: number;
  closeTabWhenDone?: boolean;
  closeBrowserWindowWhenDone?: boolean;
  totalTimeoutMs?: number;
  taskTreeOverview?: string;
  history?: string[];
  currentDescriptionEx?: string;
  /**
   * The human's answer to the question the previous run paused on (the fallback for hosts
   * without task-scoped elicitation: there the task can only end, and the answer is carried in
   * by the next call).
   */
  humanReply?: string;
  /**
   * Ask a person one question and wait for the answer. **Not an MCP parameter, an injected
   * dependency**: on the MCP side it is elicitInput (the task status goes to input_required
   * without ending the task), and on the command line it reads a line from the terminal. When
   * unavailable (the host lacks the capability, or the terminal is not interactive) pass
   * undefined and the runtime falls back to "finish and carry the question out".
   */
  askHuman?: (question: string) => Promise<string | undefined>;
  vllmEndpoint?: string;
  vllmModel?: string;
  vllmApiKey?: string;
  vllmApiStyle?: "openai" | "simple_chat";
}

/**
 * Fold the model's status into the three legal values.
 *
 * Normalising rather than validating strictly, because the model reliably produces synonyms
 * (done / in progress / and the Chinese equivalents). The fallback is partial: when unsure,
 * treat the step as unfinished and at worst look one more round; misreading it as completed
 * instead advances straight to the next leaf and drops an unfinished step.
 *
 * The Chinese variants are deliberate tolerance. The prompts are entirely in English now, but
 * the model occasionally slips back into Chinese — accepting it as a legal value when it does
 * is cheaper than voiding the whole plan and resending a round.
 */
function normalizeExecutingStepStatus(
  input: unknown,
): "completed" | "partial" | "failed" {
  // Flatten case and any spaces, underscores or hyphens: Completed, in progress, NOT_STARTED.
  //
  // The Chinese values below are matching data, not prose: models reply in Chinese often
  // enough that dropping them would silently reclassify a finished step as "partial".
  const text = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  if (
    text === "completed" ||
    text === "complete" ||
    text === "done" ||
    text === "finished" ||
    text === "success" ||
    text === "succeeded" ||
    text === "已完成"
  ) {
    return "completed";
  }

  if (
    text === "failed" ||
    text === "failure" ||
    text === "error" ||
    text === "incomplete" ||
    text === "cannotcomplete" ||
    text === "失败" ||
    text === "未完成" ||
    text === "无法完成"
  ) {
    return "failed";
  }

  // partial / inprogress / pending / paused / notstarted / awaitinguser ... and anything
  // unrecognised, all count as unfinished.
  return "partial";
}

/**
 * Normalise the model's return into a RuntimePlan.
 * It does only three things before validating: folding current_executing_step.status
 * synonyms, moving the singular action_call to action_calls, and intercepting action names the
 * runtime does not accept (INTERCEPTED_ACTIONS). Field structure and names are validated strictly by
 * RuntimePlanSchema (Zod) — garbage from the model throws a clear error rather than being
 * silently patched up.
 */
export function normalizeRuntimePlan(input: unknown): RuntimePlan {
  if (!input || typeof input !== "object") {
    throw new Error("The VLLM result is not an object");
  }

  const record = { ...(input as Record<string, unknown>) };

  normalizeCurrentStepStatus(record);
  migrateLegacyActionCall(record);
  interceptObserveAction(record);

  return RuntimePlanSchema.parse(record);
}

/**
 * When the model emits the old singular field name action_call, move it to action_calls.
 * The contract holds only action_calls; this merely stops one mistyped field name costing a
 * whole round.
 */
function migrateLegacyActionCall(record: Record<string, unknown>): void {
  const next = record.next_step_detail;
  if (!next || typeof next !== "object") return;
  const n = next as Record<string, unknown>;
  if (n.action_calls === undefined && n.action_call !== undefined) {
    n.action_calls = n.action_call;
  }
  delete n.action_call;
}

function normalizeCurrentStepStatus(record: Record<string, unknown>): void {
  const step = record.current_executing_step;
  if (step && typeof step === "object") {
    record.current_executing_step = {
      ...(step as Record<string, unknown>),
      status: normalizeExecutingStepStatus(
        (step as Record<string, unknown>).status,
      ),
    };
  }
}

/**
 * Fold the model's pause_kind into the two legal values.
 * Only a literal needs_answer is accepted; everything else becomes needs_human_on_page (the
 * field's own comment says why).
 */
function normalizePauseKind(
  raw: unknown,
): "needs_answer" | "needs_human_on_page" | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, "");
  return text === "needsanswer" ? "needs_answer" : "needs_human_on_page";
}

/**
 * What the pause needs a person for.
 *
 * When the keyword safety net matches (payment, password and the like), treat it as "a person
 * must work the page" **whatever the model filled in**: that net only fires on words that are
 * all but impossible in a harmless action, so its firing means this step cannot be settled by
 * an answer.
 */
export function pauseKindOf(
  plan: RuntimePlan,
): "needs_answer" | "needs_human_on_page" {
  if (isSensitivePause(plan)) return "needs_human_on_page";
  return plan.next_step_detail.pause_kind === "needs_answer"
    ? "needs_answer"
    : "needs_human_on_page";
}

/** Is this pause "a person has to do this step" (sign-in, payment, a captcha...)? Decided by a boolean, not by the description text. */
export function isSensitivePause(plan: RuntimePlan): boolean {
  return plan.next_step_detail.sensitive === true;
}

/**
 * Whether this pause came from the runtime intercepting something (rather than the model
 * genuinely needing a person).
 *
 * The handling differs completely: an interception is just a bad action name, an output error,
 * and re-deciding is enough; only the model asking for a pause itself really needs the tab
 * handed to a person. So this test must not match against the prose description — descriptions
 * change, and matching prose fails sooner or later. Read a boolean the runtime wrote itself.
 */
export function isInterceptedPause(plan: RuntimePlan): boolean {
  return plan.next_step_detail.intercepted === true;
}

/**
 * Action names the model may return but the runtime does not accept -> the reason for
 * intercepting. Two kinds: observation actions the runtime handles itself, and commands the
 * kernel deleted or renamed in the September 2026 protocol revision (those commands used to "succeed" falsely, so the
 * model's old habits must be stopped or it keeps reasoning from them).
 */
const INTERCEPTED_ACTIONS: Record<string, string> = {
  browser_take_snapshot: "Observation actions are performed by the runtime automatically and may not be returned as the next action",
  browserTakeSnapshot: "Observation actions are performed by the runtime automatically and may not be returned as the next action",
  takeSnapshot: "Observation actions are performed by the runtime automatically and may not be returned as the next action",
  browser_startup: "browserStartup was renamed browserNewWindow; use that name instead",
  browserStartup: "browserStartup was renamed browserNewWindow; use that name instead",
  browserWaitForElement: "waitForElement is not implemented in the kernel (it used to report that any element had appeared, which was false) and was removed. Use browserWait and confirm from the next snapshot",
  waitForElement: "waitForElement is not implemented in the kernel (it used to report that any element had appeared, which was false) and was removed. Use browserWait and confirm from the next snapshot",
  browserFreezeRender: "freezeRender is not implemented in the kernel (it used to report success unconditionally) and was removed",
  browserUnfreezeRender: "unfreezeRender is not implemented in the kernel (it used to report success unconditionally) and was removed",
  browserGetComputedLabel: "getComputedLabel was removed; the element label is in the title field of each node in annotatedContent",
  browserGetSemanticRole: "getSemanticRole was removed; the kernel never emits semantic roles and returned an empty string for every element",
  browserManageCookies: "manageCookies is not implemented in the kernel (reading a cookie always returned an empty string) and was removed",
};

/**
 * Read the list of action names out of a plan. All three shapes are accepted: an array, a bare
 * object, and the old field name action_call.
 *
 * Accepting the old name is **tolerance in the parsing layer**, not a second contract — the
 * prompt only mentions action_calls, and when the model occasionally emits the singular name,
 * taking it and noting it in the debug log beats driving it into the dead end of "no actions
 * this round", while still showing whether it keeps making the mistake.
 */
function readActionCalls(next: Record<string, unknown>): string[] {
  const raw = next.action_calls ?? next.action_call;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => String(c.function ?? ""));
}

/** Intercept an action name the runtime does not accept, turning it into a pause with an explicit reason. */
function interceptObserveAction(record: Record<string, unknown>): void {
  const next = record.next_step_detail;
  if (!next || typeof next !== "object") {
    return;
  }
  const calls = readActionCalls(next as Record<string, unknown>);
  if (!calls.length) {
    return;
  }
  // If **any** action in the batch uses an unavailable name, stop the whole batch: later
  // actions usually depend on the effect of earlier ones, and letting a partial batch through
  // is worse than stopping it.
  const bad = calls.find((c) => INTERCEPTED_ACTIONS[c]);
  if (!bad) {
    return;
  }
  const fn = bad;
  const blocked = INTERCEPTED_ACTIONS[fn];
  if (!blocked) {
    return;
  }

  const paused = { ...(next as Record<string, unknown>) };
  paused.is_paused = true;
  paused.description = blocked;
  paused.intercepted = true;
  delete paused.action_calls;
  record.next_step_detail = paused;
}
