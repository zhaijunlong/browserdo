import { createHash } from "node:crypto";
import {
  RuntimeContextState,
  RuntimePageRecord,
  RuntimeHistoryEntry,
  RuntimePlan,
} from "./runtime_types.js";
import {
  type AreaCoverage,
  mergeCoverage,
  observeAreas,
  summarize,
} from "./read_coverage.js";

/** Cap on history page records, matching Chrome's per-tab back history (50). */
const MAX_PAGE_RECORDS = 50;

/**
 * Key for a page record. Only the fragment is stripped: the query string is often the
 * search itself (Ctrip's `list/round-szx-bjs?depdate=...` with another date is a different
 * search), so normalising it away would merge two different searches into one page.
 */
function normalizePageUrl(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  const hash = raw.indexOf("#");
  return hash >= 0 ? raw.slice(0, hash) : raw;
}

export class BrowserRuntimeMemory {
  private readonly state: RuntimeContextState;
  /** Coverage with its text samples, by page. Kept out of state: the prompt only needs the summary on each page record. */
  private readonly coverage = new Map<string, AreaCoverage[]>();

  constructor(seed?: {
    taskTreeOverview?: string;
    history?: string[];
    currentDescriptionEx?: string;
    windowId?: string;
    tabId?: string;
  }) {
    this.state = {
      taskTreeOverview: seed?.taskTreeOverview ?? "",
      history: this.parseHistory(seed?.history ?? []),
      latestWindowId: seed?.windowId,
      latestTabId: seed?.tabId,
      currentDescriptionEx: seed?.currentDescriptionEx ?? "",
      consecutiveSameTargetCount: 0,
      latestTargetPath: undefined,
      pageUnchanged: false,
      humanAnswers: [],
      pages: [],
      currentPageUrl: undefined,
    };
  }

  updateTarget(windowId?: string, tabId?: string): void {
    if (windowId) {
      this.state.latestWindowId = windowId;
    }

    if (tabId) {
      this.state.latestTabId = tabId;
    }
  }

  updateAfterPlan(round: number, plan: RuntimePlan): void {
    this.state.taskTreeOverview = plan.task_tree_overview;
    this.state.currentDescriptionEx = plan.current_executing_step.description;
    this.recordTarget(plan.next_step_detail.path);

    this.state.history.push({
      round,
      path: plan.current_executing_step.path,
      description: plan.current_executing_step.description,
      status: plan.current_executing_step.status,
      result: plan.current_executing_step.result,
    });
  }

  appendExecutionResult(round: number, message: string, plan: RuntimePlan): void {
    this.state.history.push({
      round,
      path: plan.next_step_detail.path,
      description: `Executing: ${plan.next_step_detail.description}`,
      status: "partial",
      result: message,
    });
  }

  /**
   * Record that the runtime refused this batch of actions before sending them.
   * Used for model output errors such as a deleted or renamed action name: the reason must
   * enter the history, or the model cannot see it next round.
   */
  appendActionRejected(round: number, plan: RuntimePlan, note: string): void {
    this.state.history.push({
      round,
      path: plan.next_step_detail.path,
      description: "Rejected before execution",
      status: "failed",
      result: note,
    });
  }

  getSnapshot(): RuntimeContextState {
    return {
      taskTreeOverview: this.state.taskTreeOverview,
      history: [...this.state.history],
      latestWindowId: this.state.latestWindowId,
      latestTabId: this.state.latestTabId,
      currentDescriptionEx: this.state.currentDescriptionEx,
      consecutiveSameTargetCount: this.state.consecutiveSameTargetCount,
      latestTargetPath: this.state.latestTargetPath,
      pageUnchanged: this.state.pageUnchanged,
      humanAnswers: [...this.state.humanAnswers],
      pages: this.state.pages.map((p) => ({ ...p })),
      currentPageUrl: this.state.currentPageUrl,
    };
  }

  getHistoryText(): string {
    if (this.state.history.length === 0) {
      return "No execution history yet.";
    }

    return this.state.history
      .map(
        (entry) =>
          `Round ${entry.round} | ${entry.path} | ${entry.description} | ${entry.status} | ${entry.result}`,
      )
      .join("\n");
  }

  /**
   * How many distinct child nodes the model has used under a given parent.
   *
   * This watches for one evasion: "3.2.1 is stuck, so invent 3.2.2 and do the same thing",
   * where the path keeps changing and the stuck detector never fires. Note the prompt
   * **asks** for multi-step nodes to be expanded in place, so this number rises anyway; only
   * "rising while the page does not move" is suspicious. **Logged, never acted on**: real
   * deadlock is caught by pageUnchanged.
   */
  siblingCountFor(path: string): number {
    const parent = (path ?? "").trim().split(".").slice(0, -1).join(".");
    if (!parent) return 0;
    return this.childrenByParent.get(parent)?.size ?? 0;
  }

  private readonly childrenByParent = new Map<string, Set<string>>();

  /** Record this round's "next step" path and add to the stuck counter per targetRepeatIfAdopted. */
  private recordTarget(path: string): void {
    const p = (path ?? "").trim();
    const parent = p.split(".").slice(0, -1).join(".");
    if (parent) {
      const seen = this.childrenByParent.get(parent) ?? new Set<string>();
      seen.add(p);
      this.childrenByParent.set(parent, seen);
    }
    this.state.consecutiveSameTargetCount = this.targetRepeatIfAdopted(p);
    this.state.latestTargetPath = p || undefined;
  }

  /**
   * If this round's "next step" is path, how many times in a row it will have appeared. A
   * changed path, or a page that is not byte-for-byte unchanged, resets it to 1. The runtime
   * uses this to judge deadlock **before** adopting a plan, and recordTarget uses it to book
   * the result — both must share one rule, or the forced pause fires on one number while the
   * prompt reports another.
   *
   * Why the page condition: path alone gives false positives. A date widget's "open the
   * calendar -> change month -> pick a day -> close the panel" is four rounds on the same
   * path, but the page moves every round.
   *
   * **The model's self-reported status is deliberately ignored.** The observed deadlock is
   * exactly the model claiming completion every round while going nowhere; "reset on
   * completed" would keep this counter at zero forever for such a model, and a page that has
   * not changed by a single byte is evidence enough that nothing progressed.
   */
  targetRepeatIfAdopted(path: string): number {
    const p = (path ?? "").trim();
    if (!p || this.state.latestTargetPath !== p) return 1;
    if (!this.state.pageUnchanged) return 1;
    return this.state.consecutiveSameTargetCount + 1;
  }

  /**
   * Record the human's answer to a question. **Kept in state and fed to the model every
   * round** — said once on the round it arrives, the model forgets it by the next one and
   * goes back to doing what the user already ruled out.
   */
  recordHumanAnswer(question: string, answer: string): void {
    this.state.humanAnswers.push({ question, answer });
  }

  /**
   * Which page the working tab is on this round. A new URL starts a new record; returning to
   * an old URL resumes that one; at 50 records the least recently revisited is evicted.
   * Why records are filed by URL: see RuntimePageRecord.
   */
  recordPageVisit(round: number, url: string | undefined, title: string): void {
    const key = normalizePageUrl(url ?? "");
    // The current page is always rewritten, including to undefined: if a round that failed to
    // snapshot the working tab kept the previous page, this round's summary would be filed
    // against the wrong one.
    this.state.currentPageUrl = key || undefined;
    if (!key) return;
    const hit = this.state.pages.find((p) => p.url === key);
    if (hit) {
      hit.lastRound = round;
      if (title) hit.title = title;
      return;
    }
    this.state.pages.push({
      url: key,
      title,
      abstract: "",
      firstRound: round,
      lastRound: round,
    });
    if (this.state.pages.length > MAX_PAGE_RECORDS) {
      const oldest = this.state.pages.reduce((a, b) =>
        a.lastRound <= b.lastRound ? a : b,
      );
      this.state.pages = this.state.pages.filter((p) => p !== oldest);
      this.coverage.delete(oldest.url);
    }
  }

  /**
   * Fold this round's snapshot of the working tab into the current page's coverage. Call after
   * recordPageVisit, which decides what the current page is.
   */
  recordPageCoverage(round: number, annotatedContent: string | undefined): void {
    const url = this.state.currentPageUrl;
    const hit = url ? this.state.pages.find((p) => p.url === url) : undefined;
    if (!url || !hit || !annotatedContent) return;
    const observed = observeAreas(annotatedContent);
    if (!observed.length && !this.coverage.has(url)) return;
    const merged = mergeCoverage(this.coverage.get(url) ?? [], observed, round);
    this.coverage.set(url, merged);
    hit.coverage = summarize(merged);
  }

  /**
   * Record the model's summary of the **current** page. Writing the same page again
   * overwrites, because the newer one has seen more. If no page was seen this round
   * (currentPageUrl empty) the summary is dropped: filing it against the wrong page is worse
   * than not having it.
   */
  recordPageAbstract(abstract: string): void {
    const hit = this.state.pages.find(
      (p) => p.url === this.state.currentPageUrl,
    );
    if (hit) hit.abstract = abstract;
  }

  /**
   * Query the history page records (the queryHistoryPage action).
   * With no keyword this simply pages the list; with one it looks for a substring in the
   * title, the URL or the summary.
   */
  queryPages(params: {
    keyword?: string;
    offset?: number;
    limit?: number;
  }): {
    /** How many pages are recorded — on a miss this tells "nothing recorded" from "recorded but no match". */
    recorded: number;
    /** How many pages matched. */
    matched: number;
    offset: number;
    hits: RuntimePageRecord[];
  } {
    const kw = (params.keyword ?? "").trim().toLowerCase();
    const matched = kw
      ? this.state.pages.filter((p) =>
          `${p.title} ${p.url} ${p.abstract}`.toLowerCase().includes(kw),
        )
      : [...this.state.pages];
    const offset = Math.max(0, Math.trunc(params.offset ?? 0));
    const limit = Math.min(20, Math.max(1, Math.trunc(params.limit ?? 10)));
    return {
      recorded: this.state.pages.length,
      matched: matched.length,
      offset,
      hits: matched.slice(offset, offset + limit).map((p) => ({ ...p })),
    };
  }

  /** Has the human already answered this question? If so, return that answer. */
  answerFor(question: string): string | undefined {
    const q = question.trim();
    return this.state.humanAnswers.find((a) => a.question.trim() === q)?.answer;
  }

  /**
   * Record this round's annotatedContent fingerprint for the working tab and decide whether
   * the page is byte-for-byte unchanged. Called once per round, after the snapshot and
   * before decide; pass undefined when no content was captured, which counts as changed.
   *
   * The byte comparison is deliberate: identical means the page truly did not move, needs no
   * semantic judgement, and cannot give a false positive. The cost is false negatives (a
   * spinner on the page changes the bytes), and false positives are the problem we actually have.
   */
  recordPageSignature(content: string | undefined): void {
    const signature =
      content === undefined
        ? undefined
        : createHash("sha1").update(content).digest("hex");
    this.state.pageUnchanged =
      signature !== undefined && signature === this.lastPageSignature;
    this.lastPageSignature = signature;
  }

  /** Hash of the working tab's annotatedContent last round. Used only by recordPageSignature. */
  private lastPageSignature?: string;


  private parseHistory(lines: string[]): RuntimeHistoryEntry[] {
    return lines.map((line, index) => ({
      round: index + 1,
      path: `history.${index + 1}`,
      description: "history entry",
      status: "partial",
      result: line,
    }));
  }
}
