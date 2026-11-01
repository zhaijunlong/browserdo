import type { CdpRoute } from "./fake-cdp.js";

/** Every field of the pdl's TabInfo, as the browser sends it (isGhost: an agent tab); tests override what they need. */
export function tabInfo(over: Record<string, unknown> = {}) {
  return {
    tabId: "1001",
    index: 0,
    title: "Example Domain",
    url: "https://example.com/",
    isForeground: true,
    isGhost: false,
    canGoBack: false,
    canGoForward: false,
    isMuted: false,
    isAudible: false,
    ...over,
  };
}

/** Every field of the pdl's WindowInfo. */
export function windowInfo(over: Record<string, unknown> = {}) {
  return {
    windowId: "900",
    index: 0,
    title: "Example Domain",
    isHidden: false,
    windowState: "maximized",
    hasGhostTab: false,
    tabs: [tabInfo()],
    ...over,
  };
}

export function windowInfoReply(windows: unknown[] = [windowInfo()]) {
  return { windows, success: true };
}

/** The reply shape shared by the navigation commands (note: no success field, which is the very point being tested). */
export function navReply(over: Record<string, unknown> = {}) {
  return {
    windowId: "900",
    tabId: "1001",
    title: "Example Domain",
    url: "https://example.com/",
    loadStatus: "titled",
    ...over,
  };
}

/**
 * A snapshot reply, generated position by position from the requested targets tree.
 *
 * Generating position by position is not laziness — the pdl promises windows[i] is targets[i]
 * and windows[i].tabs[j] is targets[i].tabs[j], and the client indexes by exactly that. A
 * fixture that always returned one tab would leave the multi-tab path untested forever, and a
 * positional shift is the most serious failure this reply can carry (taking tab A's
 * numbers for tab B's).
 *
 * Keys in over are applied to **every** tab item; to arrange one item on its own, use perTab.
 */
export function snapshotReply(
  params: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
  perTab?: (tabId: string, index: number) => Record<string, unknown> | undefined,
) {
  const targets = Array.isArray(params.targets) ? params.targets : [];
  let n = 0;
  return {
    windows: targets.map((t: any) => ({
      windowId: String(t?.windowId ?? "900"),
      popups: [],
      tabs: (Array.isArray(t?.tabs) ? t.tabs : []).map((tab: any) => {
        const tabId = String(tab?.tabId ?? "1001");
        const i = n++;
        return {
          windowId: String(t?.windowId ?? "900"),
          tabId,
          success: true,
          // The id of this batch of numbers, which click/inputText must send back.
          snapshotId: `snap-${i + 1}`,
          annotatedImage: "UE5H-annotated",
          // Supply emsn 1-30: the action layer blocks numbers "not shown this round", and a
          // fixture with only one would shut out every test that uses a small number.
          annotatedContent: JSON.stringify({
            children: Array.from({ length: 30 }, (_, k) => ({
              node_name: "P", emsn: String(k + 1),
            })),
          }),
          popups: [],
          elapsedMs: 40 + i,
          ...over,
          ...(perTab?.(tabId, i) ?? {}),
        };
      }),
    })),
    browserPopups: [],
  };
}

/** One tab's failed entry; the other tabs of the command still answer. */
export function snapshotTabFailure(message: string) {
  return { success: false, message, snapshotId: undefined, annotatedContent: undefined, annotatedImage: undefined };
}

/**
 * A set of "everything succeeds" default routes, enough to run the whole runtime loop.
 * An individual test only overrides the one it cares about.
 */
export function happyRoutes(): Record<string, CdpRoute | unknown> {
  return {
    "Embiody.browserGetWindowInfo": () => windowInfoReply(),
    "Embiody.browserShow": { success: true },
    "Embiody.browserHide": { success: true },
    "Embiody.browserSelectTab": { success: true },
    "Embiody.browserCloseWindow": { success: true },
    "Embiody.browserCloseTab": { success: true, remainingTabsCount: 1 },
    "Embiody.browserNewWindow": {
      windowId: "901",
      tabId: "1002",
      success: true,
    },
    "Embiody.browserNewTab": () => navReply({ tabId: "1002" }),
    "Embiody.browserNavigate": (p: Record<string, unknown>) =>
      navReply({ url: String(p.url ?? "") }),
    "Embiody.browserGoBack": () => navReply(),
    "Embiody.browserGoForward": () => navReply(),
    "Embiody.browserReload": () => navReply(),
    "Embiody.browserStopLoading": { wasLoading: false },
    "Embiody.browserSetAudioMuted": (p: Record<string, unknown>) => ({
      muted: !!p.muted,
      success: true,
    }),
    "Embiody.browserClick": { success: true },
    "Embiody.browserInputText": { success: true },
    "Embiody.browserPressKey": { success: true },
    "Embiody.browserSelectEditableText": { success: true, selectedText: "⟦hi⟧" },
    "Embiody.browserScroll": { success: true },
    "Embiody.browserMove": { success: true, x: 10, y: 20 },
    "Embiody.browserDrag": { success: true, x: 10, y: 20, toX: 30, toY: 40 },
    "Embiody.browserClosePopupBubble": { closed: false, types: [] },
    "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
      snapshotReply(p),
    "Embiody.browserStartHumanControl": { success: true },
    "Embiody.browserStopHumanControl": { success: true, reason: "agentRequested" },
  };
}

export const TARGET = { windowId: "900", tabId: "1001" } as const;
