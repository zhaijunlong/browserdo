import { CdpClient } from "./cdp-client.js";
import { RuntimeActionCall, WindowInfo } from "./runtime_types.js";
import * as actions from "./browser-actions.js";

/** Result of an action: text goes into memory; targetUpdate is for actions that move the working target (browserNavigate / browserNewWindow / browserAddNewTab and friends). */
export interface ExecutionOutcome {
  text: string;
  targetUpdate?: { windowId?: string; tabId?: string };
  /** Where the tab actually landed after the action (a field of the navigation replies); the runtime updates currentUrl from it. */
  landedUrl?: string;
  /** Whether the action handed the tab to a person; while it is handed over everything except snapshots fails. */
  humanControl?: boolean;
}

/** Read the element number the model gave: emsn is the current name; nodeId is the old one, which the model still emits occasionally, so accept both. */
function readEmsn(
  p: Record<string, unknown>,
  key: "emsn" | "toEmsn" = "emsn",
): number | undefined {
  // onEmsn is browserScroll's wire name; a model that has seen it may write it that way.
  const raw = key === "emsn" ? (p.emsn ?? p.nodeId ?? p.onEmsn) : p.toEmsn;
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** A numeric parameter; models sometimes write numbers as strings. Anything unreadable counts as absent. */
function readNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** A string parameter as given, empty included; anything else counts as absent. */
function readText(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

/** browserPressKey's keys. A model may write one key, or a bare name instead of {key}; the kernel refuses an empty list or name. */
function readKeys(raw: unknown): Array<{ key: string; repeatCount?: number }> {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.map((k) =>
    typeof k === "string"
      ? { key: k }
      : { key: String(k?.key ?? ""), repeatCount: readNumber(k?.repeatCount) },
  );
}

/**
 * Normalise a boolean parameter from the model into a real boolean.
 *
 * Models often write booleans as strings ("true" / "false"). Passing those through has two
 * bad outcomes: a string reaching the kernel earns a baffling InvalidParams, and a test like
 * `p.muted !== false` reads "false" as true — the intent was to unmute and the tab gets
 * muted. Everything funnels through here. A value we cannot recognise returns the fallback
 * rather than a guess.
 */
function readBool(raw: unknown, fallback?: boolean): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  if (raw === 1) return true;
  if (raw === 0) return false;
  return fallback;
}

/** Wait parameters: the model may set them explicitly, otherwise the kernel defaults apply (waitUntil=title, timeoutMs=10000). */
function readWait(p: Record<string, unknown>): {
  waitUntil?: string;
  timeoutMs?: number;
} {
  const waitUntil =
    typeof p.waitUntil === "string" && p.waitUntil ? p.waitUntil : undefined;
  const timeoutMs = Number.isFinite(Number(p.timeoutMs))
    ? Number(p.timeoutMs)
    : undefined;
  return { waitUntil, timeoutMs };
}

/**
 * Decide which tab this action applies to.
 *
 * The model names one (params.tabId) -> validate it against this round's layout -> windowId
 * follows that tab. No name -> use the runtime's working target. Named but not in the
 * layout -> refuse outright and list the tabs that do exist.
 */
function resolveActionTarget(
  p: Record<string, unknown>,
  target: { windowId?: string; tabId?: string },
  layout?: WindowInfo[],
): { windowId?: string; tabId?: string } | { error: string } {
  const asked = usableId(p.tabId);
  if (!asked) return target;
  if (asked === target.tabId) return target;

  // An empty layout means "not fetched yet", not "the browser has no tabs" (with no tabs at
  // all there would be no working target either). We dare not trust the model's id here, and
  // should not refuse it either — use the working target, the most conservative choice.
  if (!layout || layout.length === 0) {
    return target;
  }
  for (const win of layout) {
    for (const tab of win.tabs) {
      if (tab.tabId === asked) {
        return { windowId: win.windowId, tabId: tab.tabId };
      }
    }
  }
  const existing = layout
    .flatMap((w) => w.tabs.map((t) => t.tabId))
    .join(", ");
  return {
    error: `action_call.params.tabId=${asked} is not in this round layout (it may have been closed, or the id was invented), so the action was not executed. Tabs that exist this round: ${existing || "none"}`,
  };
}

/** Whether an id an action returned can really serve as the working target. */
function usableId(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t && t !== "undefined" && t !== "null" ? t : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * Take the emsn out of the action parameters, only when the model actually supplied one.
 *
 * The usableId rule: an empty string, "undefined" and "null" all count as absent — those
 * come from the model filling a missing field with a literal, and validating against them
 * only causes harm.
 */
function readEmsnParam(
  p: Record<string, unknown>,
  key: "emsn" | "nodeId" | "toEmsn" | "onEmsn" = "emsn",
): string | undefined {
  const raw = p[key];
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s && s !== "undefined" && s !== "null" ? s : undefined;
}

/**
 * The actions that really aim at an element number, and the pdl parameters that carry one.
 * Exported because a contract test checks it against the pdl: a new command (or a new
 * parameter) taking a number that is missing here slips past the emsn gate in execute entirely.
 *
 * browserScroll's number goes out as onEmsn, but the model writes it as params.emsn like every
 * other action does; the gate reads the model's keys, the test reads the wire names.
 */
export const EMSN_WIRE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  browserClick: ["emsn"],
  browserInputText: ["emsn"],
  browserPressKey: ["emsn"],
  browserSelectEditableText: ["emsn"],
  browserMove: ["emsn"],
  browserDrag: ["emsn", "toEmsn"],
  browserScroll: ["onEmsn"],
};

export const ACTIONS_TAKING_EMSN: ReadonlySet<string> = new Set(Object.keys(EMSN_WIRE_PARAMS));

/**
 * -1 is the blank area: not an element, so never in the shown list. browserScroll uses it to
 * mean "the document itself" and the kernel refuses it unless the snapshot offered it.
 */
const BLANK_AREA_EMSN = "-1";

/**
 * These tags can **never carry text**, so browserInputText on them is certain to fail.
 *
 * Why we block it at our layer: the kernel implements browserInputText as "click to take
 * focus, then type", so an input that is doomed to fail **clicks the element first**. We hit
 * this once for real: the model typed into `56 I`, the swap icon between Ctrip's origin and
 * destination fields; the input failed, the icon got clicked, and origin and destination
 * swapped. Everything after that searched the reverse route, while the action result said
 * only "input failed".
 *
 * The list deliberately holds only tags that can never be editable. DIV / SPAN / P are not
 * in it — that is exactly what a contenteditable rich-text editor looks like, and the kernel
 * does not mark contenteditable, so including them would block places that really do accept typing.
 * SELECT is not in it either: the kernel sets a SELECT to the option named by the text, with no click.
 */
const NEVER_TYPABLE_TAGS = new Set(["I", "IMG", "SVG", "BUTTON", "A"]);

/** Take the tag name out of an annotatedContent line: `56 I`, `58 INPUT:text [pick a date]`. */
function tagFromEmsnLine(line: string | undefined): string | undefined {
  const m = /^\d+\s+([A-Za-z][A-Za-z0-9-]*)/.exec(line ?? "");
  return m ? m[1].toUpperCase() : undefined;
}

function toOutcome(res: actions.ActionResult): ExecutionOutcome {
  if (!res.ok) {
    throw new Error(res.text);
  }
  // Accept only ids that are genuinely usable. `!== undefined` is not enough of a gate: null
  // becomes "null" and an empty string becomes "", and both would be written in as a valid
  // working target, after which every command reports that the tab cannot be found.
  const targetUpdate: { windowId?: string; tabId?: string } = {};
  const windowId = usableId(res.data?.windowId);
  const tabId = usableId(res.data?.tabId);
  if (windowId) targetUpdate.windowId = windowId;
  if (tabId) targetUpdate.tabId = tabId;
  return {
    text: res.text,
    targetUpdate: Object.keys(targetUpdate).length ? targetUpdate : undefined,
    landedUrl:
      typeof res.data?.url === "string" && res.data.url
        ? res.data.url
        : undefined,
    humanControl: res.data?.humanControl === true ? true : undefined,
  };
}

/**
 * When a number is not in the list, give the model the nearest usable numbers on either side
 * along with the text of those lines.
 *
 * Saying only "pick another" does not rescue it: in the observed run the model wanted "Air
 * China" (105) and gave 104, and 104 was a hole in the numbering — that round the kernel
 * issued 223 numbers across the range 0-265, with 42 holes in between. It gave the same 104
 * twice, then gave up and handed over to a person, while the right answer sat next door.
 * This is mitigation, not a cure (the cure is the model not misreading numbers), but it only
 * costs a few dozen characters, and only on failure.
 */
function nearbyEmsn(
  wanted: string,
  allowed: ReadonlyMap<string, string>,
  span = 2,
): string {
  const target = Number(wanted);
  if (!Number.isFinite(target)) return "";
  const nums = [...allowed.keys()]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const near = [
    ...nums.filter((n) => n < target).slice(-span),
    ...nums.filter((n) => n > target).slice(0, span),
  ];
  if (!near.length) return "";
  return (
    `The nearest usable numbers are: ` +
    near.map((n) => `[${allowed.get(String(n))}]`).join(", ") +
    `.`
  );
}

/**
 * The acting side: route action_call.function to the matching function in browser-actions.
 * Called directly, with no bridge or MCP envelope in between.
 *
 * **The trust rule for windowId/tabId**: a round may show the model several tabs, and each
 * tab numbers its emsn independently — so the model **must** be able to say which tab it is
 * acting on, or the emsn cannot be resolved. Hence the rule is "a validated choice", not
 * "never trust": the model may name a tab in params.tabId, but that tabId has to appear in
 * **this round's layout**. An invented one is refused with a list of the tabs that exist,
 * rather than being sent to the kernel in exchange for "No Tab found". With no name, the
 * runtime's working target is used. windowId always follows the chosen tab; the model need
 * not — and should not — fill it in.
 */
export class BrowserRuntimeExecutor {
  constructor(private readonly cdp: CdpClient) {}

  async execute(
    ...args: Parameters<BrowserRuntimeExecutor["dispatch"]>
  ): Promise<ExecutionOutcome> {
    try {
      return await this.dispatch(...args);
    } catch (error) {
      // The action layer words this for an outside agent; here the way out is snapshot_tabs.
      if (error instanceof Error && actions.isMissingSnapshotId(error.message)) {
        const [actionCall, target, layout] = args;
        const resolved = resolveActionTarget(actionCall.params as Record<string, unknown>, target, layout);
        const tabId = ("error" in resolved ? undefined : resolved.tabId) ?? "?";
        throw new Error(
          `${actionCall.function} is missing snapshotId: tab ${tabId} was not captured this round, so there is no valid batch of element numbers for it. To operate on this tab, put its tabId into next_step_detail.snapshot_tabs and act once you have its screenshot next round`,
        );
      }
      throw error;
    }
  }

  private async dispatch(
    actionCall: RuntimeActionCall,
    target: { windowId?: string; tabId?: string },
    /** This round's layout, used to validate a tabId the model names. Without it this degrades to using the working target only. */
    layout?: WindowInfo[],
    /**
     * This round's snapshot ids per tab (tabId -> snapshotId).
     * Element actions (click, inputText, pressKey, selectEditableText, move, drag, and scroll
     * on a pane) must carry the id of the target tab's batch; a tab not captured this
     * round has none, and the action layer uses that to say "put it in snapshot_tabs first"
     * instead of sending an empty string to the kernel.
     */
    snapshotIds?: ReadonlyMap<string, string>,
    /**
     * The emsn shown to the model this round, per tab (tabId -> the full set of emsn).
     * Used to block "the model gave a number we never showed it".
     */
    emsnSets?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): Promise<ExecutionOutcome> {
    const p = actionCall.params as Record<string, unknown>;
    const resolved = resolveActionTarget(p, target, layout);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    target = resolved;
    const snapshotId = target.tabId
      ? snapshotIds?.get(target.tabId)
      : undefined;

    // A number from the model must be one we **showed it** this round.
    //
    // The kernel validates too, but what it validates is "this number belongs to this batch"
    // — its numbering table is larger than what annotatedContent renders, so a number that
    // was never shown is still recognised and clicked. We hit this once for real: the model
    // gave emsn=41 (the numbering on text_infos had been missed in rendering that round), the
    // kernel clicked it, and 16 September silently became 1 September while the action result
    // said "clicked".
    //
    // Blocking here has the advantage of offering a way out: tell the model the number is not
    // in this round's list and let it choose again. Only some actions really take an
    // emsn (see EMSN_WIRE_PARAMS). The check must be limited to those that do: a stray emsn
    // on, say, browserNavigate would have this gate refuse a **legitimate** action over a
    // parameter the kernel never even looks at.
    const takesEmsn = ACTIONS_TAKING_EMSN.has(actionCall.function);
    // browserDrag names two elements, and the far end has to pass the same gate as the near one.
    const wantedList = takesEmsn
      ? [readEmsnParam(p, "emsn") ?? readEmsnParam(p, "nodeId"), readEmsnParam(p, "toEmsn"), readEmsnParam(p, "onEmsn")].filter(
          (v): v is string =>
            v !== undefined &&
            !(actionCall.function === "browserScroll" && v === BLANK_AREA_EMSN),
        )
      : [];
    const wanted = wantedList[0];
    const allowed = target.tabId ? emsnSets?.get(target.tabId) : undefined;
    for (const n of wantedList) {
      if (allowed && allowed.size && !allowed.has(n)) {
        throw new Error(
          `emsn=${n} is not in this round element list (there are ${allowed.size} usable numbers this round). ` +
            `You may have read it off the annotated image, where dense numbers overlap and misreading is common; ` +
            `the numbers are not contiguous either, so being off by one often lands in a gap. ` +
            nearbyEmsn(n, allowed) +
            `Go back to annotatedContent and pick again by the number at the start of each line. That list is the only usable source of numbers.`,
        );
      }
    }
    // Typing into an element that can never carry text: blocked before it is sent. The kernel
    // path would **click first** and only then find it cannot type, and that click may change
    // the page state (see NEVER_TYPABLE_TAGS).
    if (actionCall.function === "browserInputText" && wanted !== undefined) {
      const tag = tagFromEmsnLine(allowed?.get(wanted));
      if (tag && NEVER_TYPABLE_TAGS.has(tag)) {
        throw new Error(
          `emsn=${wanted} is a ${tag}, which can never hold text, so nothing was typed and ` +
            `**the element was not touched** — typing would have clicked it first and that click ` +
            `can change the page. Its line this round reads: ${allowed?.get(wanted)}. ` +
            `Pick the numbered <input> or <textarea> you actually meant, or use browserClick if ` +
            `clicking this element is what you wanted.`,
        );
      }
    }

    switch (actionCall.function) {
      case "browserNavigate":
        return toOutcome(
          await actions.browserNavigate(this.cdp, {
            url: String(p.url ?? ""),
            windowId: target.windowId,
            tabId: target.tabId,
            ...readWait(p),
          }),
        );

      case "browserGoBack":
        return toOutcome(
          await actions.browserGoBack(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
            ...readWait(p),
          }),
        );

      case "browserGoForward":
        return toOutcome(
          await actions.browserGoForward(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
            ...readWait(p),
          }),
        );

      case "browserReload":
        return toOutcome(
          await actions.browserReload(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
            bypassCache: readBool(p.bypassCache),
            resubmitForm: readBool(p.resubmitForm),
            ...readWait(p),
          }),
        );

      case "browserStopLoading":
        return toOutcome(
          await actions.browserStopLoading(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
          }),
        );

      case "browserClick":
        return toOutcome(
          await actions.browserClick(this.cdp, {
            x: p.x as number | undefined,
            y: p.y as number | undefined,
            emsn: readEmsn(p),
            button: p.button as "left" | "right" | "middle" | undefined,
            clickCount: p.clickCount as number | undefined,
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );

      case "browserInputText":
        return toOutcome(
          await actions.browserInputText(this.cdp, {
            text: String(p.text ?? ""),
            clearText: readBool(p.clearText),
            pressEnter: readBool(p.pressEnter),
            emsn: readEmsn(p),
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
            before: readText(p.before),
            after: readText(p.after),
            replace: readText(p.replace),
            at: p.at === "start" || p.at === "end" ? p.at : undefined,
            occurrence: readNumber(p.occurrence),
          }),
        );

      case "browserPressKey":
        return toOutcome(
          await actions.browserPressKey(this.cdp, {
            keys: readKeys(p.keys ?? p.key),
            repeatDelayMs: readNumber(p.repeatDelayMs),
            emsn: readEmsn(p),
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );

      case "browserSelectEditableText": {
        const emsn = readEmsn(p);
        if (emsn === undefined) {
          return toOutcome({ ok: false, text: "browserSelectEditableText needs params.emsn, the field or editable area to select in" });
        }
        return toOutcome(
          await actions.browserSelectEditableText(this.cdp, {
            emsn,
            select: readText(p.select),
            from: readText(p.from),
            to: readText(p.to),
            all: readBool(p.all),
            occurrence: readNumber(p.occurrence),
            toOccurrence: readNumber(p.toOccurrence),
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );
      }

      case "browserScroll":
        return toOutcome(
          await actions.browserScroll(this.cdp, {
            deltaX: readNumber(p.deltaX),
            deltaY: readNumber(p.deltaY),
            toX: readNumber(p.toX),
            toY: readNumber(p.toY),
            onEmsn: readEmsn(p),
            repeatCount: readNumber(p.repeatCount),
            repeatDelayMs: readNumber(p.repeatDelayMs),
            speed: readNumber(p.speed),
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );

      case "browserMove":
        return toOutcome(
          await actions.browserMove(this.cdp, {
            x: p.x as number | undefined,
            y: p.y as number | undefined,
            emsn: readEmsn(p),
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );

      case "browserDrag":
        return toOutcome(
          await actions.browserDrag(this.cdp, {
            x: p.x as number | undefined,
            y: p.y as number | undefined,
            emsn: readEmsn(p),
            toEmsn: readEmsn(p, "toEmsn"),
            toX: p.toX as number | undefined,
            toY: p.toY as number | undefined,
            dx: p.dx as number | undefined,
            dy: p.dy as number | undefined,
            button: p.button as "left" | "right" | "middle" | undefined,
            holdMs: p.holdMs as number | undefined,
            settleMs: p.settleMs as number | undefined,
            windowId: target.windowId,
            tabId: target.tabId,
            snapshotId,
          }),
        );

      case "browserClosePopupBubble":
        return toOutcome(
          await actions.browserClosePopupBubble(this.cdp, {
            action: p.action as "allow" | "deny" | "dismiss" | undefined,
            windowId: target.windowId,
            tabId: target.tabId,
          }),
        );

      case "browserSetAudioMuted":
        return toOutcome(
          await actions.browserSetAudioMuted(this.cdp, {
            // With no muted given, treat it as "mute" — the common intent behind this action is to quieten the page.
            muted: readBool(p.muted, true)!,
            windowId: target.windowId,
            tabId: target.tabId,
          }),
        );

      case "browserWait":
        return toOutcome(
          await actions.browserWait(this.cdp, {
            durationMs: p.durationMs as number | undefined,
          }),
        );

      case "browserCloseTab":
        return toOutcome(
          await actions.browserCloseTab(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
          }),
        );

      case "browserNewWindow":
        return toOutcome(
          await actions.browserNewWindow(this.cdp, {
            url: p.url as string | undefined,
            hideWindow: readBool(p.hideWindow),
            incognito: readBool(p.incognito),
          }),
        );

      case "browserAddNewTab":
        return toOutcome(
          await actions.browserAddNewTab(this.cdp, {
            url: p.url as string | undefined,
            windowId: target.windowId,
            foreground: readBool(p.foreground),
            ...readWait(p),
          }),
        );

      case "browserCloseWindow":
        return toOutcome(
          await actions.browserCloseWindow(this.cdp, {
            windowId: target.windowId,
          }),
        );

      case "browserStartHumanControl":
        return toOutcome(
          await actions.browserStartHumanControl(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
            showWindow: readBool(p.showWindow),
          }),
        );

      case "browserStopHumanControl":
        return toOutcome(
          await actions.browserStopHumanControl(this.cdp, {
            windowId: target.windowId,
            tabId: target.tabId,
          }),
        );

      // Actions the runtime answers itself never reach here: the main loop intercepts them
      // before the executor (they read the task history page records, which belong to memory
      // and should not be the executor's business).
      case "queryHistoryPage":
        throw new Error(
          "queryHistoryPage is answered by the runtime, not the browser; it must not reach the executor",
        );

      default: {
        const neverAction: never = actionCall.function;
        throw new Error(`Unknown action: ${String(neverAction)}`);
      }
    }
  }
}
