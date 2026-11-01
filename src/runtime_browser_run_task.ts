import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, TaskStatus } from "@modelcontextprotocol/sdk/types.js";
import { CdpClient } from "./cdp-client.js";
import { BrowserRuntimeExecutor } from "./runtime_executor.js";
import { BrowserRuntimeMemory } from "./runtime_memory.js";
import { RuntimeVllmClient } from "./runtime_vllm.js";
import {
  BrowserRunTaskArgs,
  dropRedundantFocusClicks,
  isBatchTerminatingAction,
  isInterceptedPause,
  isSensitivePause,
  pauseKindOf,
  resolveSnapshotTabs,
  RUNTIME_ANSWERED_ACTIONS,
  snapshotBlockedReason,
  RuntimeActionCall,
  RuntimeEvent,
  RuntimeObservation,
  RuntimePlan,
  TabSnapshot,
  TabSnapshotFailure,
  WindowInfo,
} from "./runtime_types.js";
import {
  browserCloseTab,
  browserCloseWindow,
  browserGetWindowInfo,
  browserShow,
  browserStartHumanControl,
  browserStopHumanControl,
  explainSnapshotFailure,
  snapshotRetryIsPointless,
  takeSnapshots,
  type SnapshotBatchResult,
} from "./browser-actions.js";
import { discoverWorkingTarget } from "./embiody-browser.js";
import { taskTreeParseStats } from "./runtime_task_tree.js";
import { getSensitiveWords } from "./runtime_config.js";
import {
  DEFAULT_SENSITIVE_WORDS,
  findSensitive,
  type SensitiveWords,
} from "./runtime_sensitive.js";
import {
  MAX_ACTIONS_PER_ROUND,
  MAX_SAME_TARGET_ROUNDS,
  POST_ACTION_WAIT_MS,
  POST_NAVIGATE_WAIT_MS,
  ROUND_INTERVAL_MS,
  SNAPSHOT_RETRY_DELAY_MS,
} from "./config.js";
import { withInstallNotice } from "./install_notice.js";
import { appendDebugLog } from "./logger.js";
import {
  registerTask,
  getTask,
  unregisterTask,
} from "./runtime_task_registry.js";
import type { StopToken } from "./runtime_task_registry.js";

const BrowserRunTaskInputSchema = {
  task: z.string().describe("The web task the user wants done."),
  windowId: z.string().optional().describe("Existing window ID. Pass it to resume the task in that window."),
  tabId: z.string().optional().describe("Existing tab ID. Pass it to resume the task in that tab."),
  // No upper bound, so MCP accepts what the CLI's `--max-rounds` accepts; totalTimeoutMs is the
  // budget backstop.
  maxRounds: z.number().int().min(1).optional().default(12),
  closeTabWhenDone: z.boolean().optional().default(false).describe("Close the tab once the task finishes."),
  closeBrowserWindowWhenDone: z
    .boolean()
    .optional()
    .default(false)
    .describe("Close the browser window this task runs in once it finishes. Other windows are unaffected."),
  totalTimeoutMs: z
    .number()
    .int()
    .min(10_000)
    .optional()
    .describe("Overall timeout for one task, in milliseconds. Defaults to 5 minutes."),
  taskTreeOverview: z.string().optional().describe("Task tree as of the previous round."),
  history: z.array(z.string()).optional().describe("Results of the steps executed so far."),
  currentDescriptionEx: z.string().optional().describe("Steps already executed locally in the previous round."),
  humanReply: z
    .string()
    .optional()
    .describe(
      "The human's answer to the question the previous run paused on. Pass it together with windowId/tabId to carry the answer into the resumed run.",
    ),
  // The model endpoint/model/key/style are deliberately NOT tool parameters.
  //
  // A tool parameter is filled in by the host's own model, so a key passed that way has to
  // travel through the model's context first and then shows up in tool-call transcripts and
  // logs. Credentials reach us through the process environment instead (EMBIODY_VLLM_*) or
  // through a config file — channels the host sets when it spawns us, which the model never
  // sees. RunBrowserTaskArgs still carries these fields for in-process callers such as the
  // CLI path and the integration tests.
};

export class BrowserRunTaskRuntime {
  /**
   * The layout from the most recent observe. The executor validates a params.tabId the model
   * names against it. Refreshed every observe (browserGetWindowInfo costs about 1ms), so it is
   * always this round's reality.
   */
  private lastLayout: WindowInfo[] = [];
  /**
   * This round's snapshot ids per tab (tabId -> snapshotId). click/inputText must carry one.
   * Rebuilt every observe: last round's ids are already void on the kernel side, and keeping
   * them only buys a refusal.
   */
  private snapshotIds = new Map<string, string>();
  /** The full set of emsn shown to the model this round, per tab, so the action layer can block numbers never shown. */
  private emsnSets = new Map<string, ReadonlyMap<string, string>>();
  /** The "most of the task tree will not parse" warning is emitted only once. */
  private warnedTreeUnparsable = false;
  private readonly executor: BrowserRuntimeExecutor;
  private readonly memory: BrowserRuntimeMemory;
  private readonly vllm: RuntimeVllmClient;

  constructor(
    private readonly cdp: CdpClient,
    private readonly args: BrowserRunTaskArgs,
    private readonly stopToken?: StopToken,
  ) {
    this.executor = new BrowserRuntimeExecutor(cdp);
    this.memory = new BrowserRuntimeMemory({
      taskTreeOverview: args.taskTreeOverview,
      history: args.history,
      currentDescriptionEx: args.currentDescriptionEx,
      windowId: args.windowId,
      tabId: args.tabId,
    });
    // An answer the previous run asked for and the caller carried in: same path as an answer obtained in place, fed every round.
    if (args.humanReply?.trim()) {
      this.memory.recordHumanAnswer(
        "asked in an earlier run of this task",
        args.humanReply.trim(),
      );
    }
    this.vllm = new RuntimeVllmClient({
      endpoint: args.vllmEndpoint,
      model: args.vllmModel,
      apiKey: args.vllmApiKey,
      apiStyle: args.vllmApiStyle,
    });
  }

  private createStepUpdate(
    round: number,
    stage: RuntimeEvent["stage"],
    message: string,
    extras?: Pick<RuntimeEvent, "plan" | "executionResult">,
  ): RuntimeEvent {
    return {
      type: "step_update",
      round,
      stage,
      message,
      ...extras,
    };
  }

  /**
   * The main loop:
   *   resuming (windowId/tabId supplied) -> capture first, then decide
   *   brand new -> a planning-only first round (no screenshot); the first action is usually navigate
   *   then repeatedly: act -> observe(takeSnapshot) -> decide, until complete / paused /
   *   the total timeout / the round cap
   */
  async *run(): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    const maxRounds = this.args.maxRounds ?? 12;
    // A value that is not a positive number would disable the limit (elapsed > NaN is never true).
    const envTotal = Number(process.env.EMBIODY_TOTAL_TIMEOUT_MS);
    const totalTimeoutMs =
      this.args.totalTimeoutMs ??
      (Number.isFinite(envTotal) && envTotal > 0 ? envTotal : 5 * 60 * 1000);
    const startedAt = Date.now();

    await appendDebugLog("browser_run_task", "task started", {
      windowId: this.args.windowId,
      tabId: this.args.tabId,
      maxRounds,
      totalTimeoutMs,
    });

    // 1. Establish the working target.
    const isResume = !!(this.args.windowId && this.args.tabId);
    let windowId: string;
    let tabId: string;
    if (isResume) {
      windowId = this.args.windowId!;
      tabId = this.args.tabId!;
      this.memory.updateTarget(windowId, tabId);
      // Fetch a layout before the first decide: the executor validates a params.tabId the model
      // names against it.
      this.lastLayout = await this.readLayout(0);
      await appendDebugLog("browser_run_task", "resume mode", {
        windowId,
        tabId,
        tabs: this.lastLayout.reduce((n, w) => n + w.tabs.length, 0),
      });
      yield this.createStepUpdate(
        0,
        "bootstrap",
        `Resuming in window windowId=${windowId}, tabId=${tabId}`,
      );
    } else {
      yield this.createStepUpdate(0, "bootstrap", "Finding the working window (browserGetWindowInfo)");
      const discovered = await discoverWorkingTarget(this.cdp);
      windowId = discovered.windowId;
      tabId = discovered.tabId;
      // Picking the target already fetched a layout, so keep it: otherwise lastLayout is empty
      // during the planning-only first round and a params.tabId the model names in its first
      // plan is refused for nothing.
      this.lastLayout = discovered.layout;
      this.memory.updateTarget(windowId, tabId);
      await appendDebugLog("browser_run_task", "working window resolved", {
        windowId,
        tabId,
      });
      yield this.createStepUpdate(
        0,
        "bootstrap",
        `Working window ready, windowId=${windowId}, tabId=${tabId}`,
      );
    }

    // Take control back before resuming: the previous stretch may have handed the tab to a
    // person over a sensitive action, and while it is handed over everything but a snapshot
    // fails, so without taking it back not a single step can run.
    if (isResume) {
      yield* this.reclaimFromHuman(0, windowId, tabId);
    }

    // Show and maximise the working window at task start, so the bitmap can be grabbed.
    try {
      await browserShow(this.cdp, { windowId, toState: "Maximized" });
      await appendDebugLog("browser_run_task", "working window shown and maximised", {
        windowId,
      });
      yield this.createStepUpdate(0, "bootstrap", "Working window shown and maximised");
    } catch (error) {
      const showError = error instanceof Error ? error.message : String(error);
      await appendDebugLog("browser_run_task", "browserShow failed (ignored)", {
        error: showError,
      });
      yield this.createStepUpdate(
        0,
        "bootstrap",
        `Failed to show the working window; later screenshots may capture no bitmap: ${showError}`,
      );
    }

    const modelInfo = this.vllm.getModelInfo();
    yield this.createStepUpdate(
      0,
      "bootstrap",
      `Model: ${modelInfo.model} @ ${modelInfo.endpoint}`,
    );

    // 2. The first decision.
    let plan: RuntimePlan;
    if (isResume) {
      // A resumed first round has no "previous plan", so let the runtime choose by its fallback.
      const observation = yield* this.observe(1, undefined, { windowId, tabId });
      plan = yield* this.decide(1, observation);
      this.memory.updateAfterPlan(1, plan);
    } else {
      yield this.createStepUpdate(0, "decide", "First round is planning only (no screenshot)");
      plan = yield* this.decide(0, undefined);
      this.memory.updateAfterPlan(0, plan);
    }

    if (plan.all_task_is_complete) {
      return yield* this.finish(plan, isResume ? 1 : 0, windowId, tabId);
    }
    if (plan.next_step_detail.is_paused) {
      const settled = yield* this.settlePause(plan, isResume ? 1 : 0, windowId, tabId);
      if (settled.done) return settled.plan;
      plan = settled.plan;
    }

    if (this.isStopped()) {
      return yield* this.stopAndFinish(isResume ? 1 : 0, windowId, tabId);
    }

    // 3. The main loop: act -> observe -> decide.
    let round = 1;
    while (round <= maxRounds) {
      if (this.isStopped()) {
        return yield* this.stopAndFinish(round, windowId, tabId);
      }
      await appendDebugLog("browser_run_task", "round heartbeat", {
        round,
        elapsedMs: Date.now() - startedAt,
      });

      if (Date.now() - startedAt > totalTimeoutMs) {
        await appendDebugLog("browser_run_task", "overall timeout", {
          round,
          elapsedMs: Date.now() - startedAt,
        });
        throw new Error(`Task exceeded its overall timeout (${totalTimeoutMs}ms)`);
      }

      if (!plan.next_step_detail.action_calls?.length) {
        await appendDebugLog(
          "browser_run_task",
          "No action_calls this round; observing and deciding once more",
          { round },
        );
        const waitObservation = yield* this.observe(
          round,
          plan.next_step_detail.snapshot_tabs,
          { windowId, tabId },
          plan.next_step_detail.read_whole_page,
        );
        plan = yield* this.decide(round, waitObservation);
        this.memory.updateAfterPlan(round, plan);
        if (plan.all_task_is_complete) {
          return yield* this.finish(plan, round, windowId, tabId);
        }
        let resumedFromPause = false;
        if (plan.next_step_detail.is_paused) {
          const settled = yield* this.settlePause(plan, round, windowId, tabId);
          if (settled.done) return settled.plan;
          plan = settled.plan;
          resumedFromPause = true;
        }
        if (!plan.next_step_detail.action_calls?.length) {
          if (resumedFromPause) {
            // Just out of a pause, so the plan legitimately holds no actions: wait for the next
            // round to decide again. This is not "the model gave no actions several rounds running".
            round += 1;
            await this.sleep(ROUND_INTERVAL_MS);
            continue;
          }
          throw new Error("The model gave no action_calls two rounds running; task aborted");
        }
      }

      // Drop the redundant "click this box then type into it" click — harmful for controls like
      // date fields — before applying the cap: a dropped click should not take a slot.
      const { batch: cleaned, dropped } = dropRedundantFocusClicks(
        plan.next_step_detail.action_calls!,
      );
      // Drop anything past the cap and say so. Every action in a batch bets on the same
      // snapshot, and the later it is the likelier that snapshot no longer holds — so this cap
      // is a guard rail, not a performance knob.
      const batch = cleaned.slice(0, MAX_ACTIONS_PER_ROUND);
      const overflow = cleaned.length - batch.length;
      if (dropped.length) {
        await appendDebugLog("browser_run_task", "dropped redundant focus clicks", {
          round,
          emsn: dropped,
        });
      }

      yield this.createStepUpdate(
        round,
        "act",
        batch.length === 1
          ? `Running action: ${batch[0].function}`
          : `Running ${batch.length} actions: ${batch.map((c) => c.function).join(" -> ")}`,
        { plan },
      );

      const outcome = yield* this.runBatch(round, batch, overflow, {
        windowId,
        tabId,
      }, dropped);
      windowId = outcome.windowId;
      tabId = outcome.tabId;
      const executionResult = outcome.text;

      this.memory.appendExecutionResult(round, executionResult, plan);
      if (outcome.handedToHuman) {
        // The action itself already handed over, so startHumanControl is not called here (that would be a redundant round trip).
        return yield* this.finish(
          this.markHandedToHuman(plan, executionResult),
          round,
          windowId,
          tabId,
        );
      }
      await appendDebugLog("browser_run_task", "batch finished", {
        round,
        executed: outcome.executed,
      });
      yield this.createStepUpdate(
        round,
        "act",
        `Finished (${outcome.executed}/${batch.length} actions) -> ${executionResult}`,
        { plan, executionResult },
      );

      // Wait once after the batch rather than once per action — this is where batching saves
      // most of its time. If the batch changed the page, wait the navigation duration (a heavy
      // SPA needs longer to finish loading). Scrolls alone need none: since F0 a scroll replies
      // once it is at rest.
      const scrollsOnly = batch.every((a) => a.function === "browserScroll");
      await this.sleep(
        outcome.pageChanged ? POST_NAVIGATE_WAIT_MS : scrollsOnly ? 0 : POST_ACTION_WAIT_MS,
      );

      // The model named the tabs to look at in last round's plan; capture exactly that list.
      const observation = yield* this.observe(
        round,
        plan.next_step_detail.snapshot_tabs,
        { windowId, tabId },
        plan.next_step_detail.read_whole_page,
      );
      plan = yield* this.decide(round, observation);
      this.memory.updateAfterPlan(round, plan);

      if (plan.all_task_is_complete) {
        return yield* this.finish(plan, round, windowId, tabId);
      }
      if (plan.next_step_detail.is_paused) {
        const settled = yield* this.settlePause(plan, round, windowId, tabId);
        if (settled.done) return settled.plan;
        plan = settled.plan;
      }

      round += 1;
      await this.sleep(ROUND_INTERVAL_MS);
    }

    await appendDebugLog("browser_run_task", "max rounds reached", { maxRounds });
    throw new Error(`Reached the maximum of ${maxRounds} rounds; task aborted`);
  }

  /**
   * observe: refetch the layout, then capture the tabs the model named, concurrently.
   *
   * Three deliberate choices:
   *
   * 1. **The layout is refetched every round** (about 1ms). Pages open tabs on their own
   *    (window.open, target=_blank) outside any action, so updating only after we touch a tab
   *    is bound to miss them. It is also the only authority on whether a tab is blank or still
   *    exists, which is why the runtime keeps no currentUrl of its own.
   *
   * 2. **No browserShow / browserSelectTab before capturing.** Measured on Embiody/0.8.0.21, a
   *    background tab — even in a hidden window — captures in 65-175ms without changing which
   *    tab is in front. Bringing it to the front first would only steal the tab the user is
   *    looking at.
   *
   * 3. **A tab that cannot be captured does not kill the round**; it becomes one failure reason
   *    for the model, so a single blank page cannot end the task.
   */
  private async *observe(
    round: number,
    requested: string[] | undefined,
    target: { windowId: string; tabId: string },
    /** The model asked for next_step_detail.read_whole_page last round. */
    long = false,
  ): AsyncGenerator<RuntimeEvent, RuntimeObservation, void> {
    const layout = await this.readLayout(round);
    this.lastLayout = layout;
    const resolved = resolveSnapshotTabs({ requested, layout, target });

    await appendDebugLog("browser_run_task", "layout refreshed", {
      round,
      windows: layout.length,
      tabs: layout.reduce((n, w) => n + w.tabs.length, 0),
      requested: requested ?? null,
      long,
      willSnapshot: resolved.tabs.map((t) => t.tabId),
      chosenByRuntime: resolved.chosenByRuntime,
      rejected: resolved.rejected,
    });

    const failures: TabSnapshotFailure[] = [...resolved.rejected];
    if (resolved.truncatedNote) {
      failures.push({ tabId: "-", reason: resolved.truncatedNote });
    }

    // Leave out tabs not worth capturing (blank pages; see snapshotBlockedReason).
    const capturable: typeof resolved.tabs = [];
    for (const t of resolved.tabs) {
      const blocked = snapshotBlockedReason(t);
      if (blocked) failures.push({ tabId: t.tabId, reason: blocked });
      else capturable.push(t);
    }

    if (capturable.length === 0) {
      // No images at all means no ids at all. Keeping last round's is worse: the kernel refuses,
      // and its reason ("the batch you gave is not the one I hold") guides the model nowhere.
      this.snapshotIds = new Map();
      this.emsnSets = new Map();
      // With no fingerprint to compare, treat the page as changed: when unsure, do not lean
      // towards a forced pause.
      this.memory.recordPageSignature(undefined);
      // No page was seen this round: clear the current page, so this round's summary is not filed against the previous one.
      this.memory.recordPageVisit(round, undefined, "");
      yield this.createStepUpdate(
        round,
        "observe",
        `No tab could be captured this round (${failures.map((f) => f.reason).join("; ") || "the layout is empty"}); deciding without images`,
      );
      return {
        layout,
        snapshots: [],
        failures,
        // With nothing captured there is no popup reading — popups come back with a snapshot, they are not queried separately.
        windowPopups: new Map(),
        browserPopups: [],
        chosenByRuntime: resolved.chosenByRuntime,
        chosenReason: resolved.chosenReason,
      };
    }

    yield this.createStepUpdate(
      round,
      "observe",
      `Capturing ${capturable.length} tab(s): ${capturable.map((t) => t.tabId).join(", ")}`,
    );

    // One command captures every tab: one round trip, with the kernel capturing the tabs concurrently.
    const batch = await this.captureBatch(
      round,
      capturable.map((t) => ({ ...t, long })),
    );
    const snapshots = batch.snapshots;
    failures.push(...batch.failures);

    await appendDebugLog("browser_run_task", "capture finished", {
      round,
      ok: snapshots.map((s) => ({
        tabId: s.tabId,
        imageBytes: s.annotatedImage?.length ?? 0,
        noImageReason: s.noImageReason ?? null,
        contentChars: s.annotatedContent.length,
        // The kernel's per-item duration. On a large batch these all rise together (PNG encoding
        // occupies the UI thread) and it is the only objective reading of "this batch was too big".
        elapsedMs: s.elapsedMs ?? null,
        // The kernel's sentence for "the deadline passed while the page was still loading, so I
        // captured anyway"; it triggers reshootStillLoading, so the log shows how often it fires.
        loadingMessage: s.loadingMessage ?? null,
      })),
      windowPopups: [...batch.windowPopups].map(([w, ps]) => ({
        windowId: w,
        types: ps.map((p) => p.type),
      })),
      browserPopups: batch.browserPopups.map((p) => p.type),
      failures,
    });
    // Only the working tab matters: the others are tabs the model asked to glance at, and
    // whether they changed says nothing about whether the current step progressed. Pass
    // undefined when the working tab was not captured.
    const working = snapshots.find((snap) => snap.tabId === target.tabId);
    this.memory.recordPageSignature(working?.annotatedContent);
    // Task history page records. The title comes from the layout — a snapshot's targets carry a url but no title.
    this.memory.recordPageVisit(
      round,
      working?.url,
      this.lastLayout.flatMap((w) => w.tabs).find((t) => t.tabId === target.tabId)
        ?.title ?? "",
    );
    this.memory.recordPageCoverage(round, working?.annotatedContent);

    yield this.createStepUpdate(
      round,
      "observe",
      `Capture done: ${snapshots.length} succeeded${failures.length ? `, ${failures.length} failed or refused` : ""}`,
    );

    // Rebuild the id table. Last round's ids are already void on the kernel side (another
    // capture voids them) and keeping them only buys a refusal; a tab that was not captured
    // simply has no id, and the action layer uses that to give the model a way forward.
    this.snapshotIds = new Map(snapshots.map((s) => [s.tabId, s.snapshotId]));
    // Record the full set of numbers shown per tab as well, so the action layer can block numbers never shown.
    this.emsnSets = new Map(
      snapshots.flatMap((s) => (s.emsnLines ? [[s.tabId, s.emsnLines] as const] : [])),
    );

    return {
      layout,
      snapshots,
      failures,
      windowPopups: batch.windowPopups,
      browserPopups: batch.browserPopups,
      chosenByRuntime: resolved.chosenByRuntime,
      chosenReason: resolved.chosenReason,
    };
  }

  /**
   * Capture a batch, then recapture only the failures.
   *
   * Never the whole batch: the successful items already hold their numbers and capturing again
   * voids them. Deterministic failures (tab gone, blank page) are not retried at all.
   *
   * **A command-level throw must not kill the round either.** A single tab's problem comes back
   * as that item's success:false, but transport failures, InvalidParams and old kernels still
   * throw for the whole command — and "no images this round" is something the model can
   * handle, so it degrades to one failure reason per tab.
   */
  private async captureBatch(
    round: number,
    targets: Array<{ windowId: string; tabId: string; url: string; long?: boolean }>,
  ): Promise<SnapshotBatchResult> {
    const shoot = async (
      group: Array<{ windowId: string; tabId: string; url: string; long?: boolean }>,
    ): Promise<SnapshotBatchResult> => {
      try {
        return await takeSnapshots(this.cdp, {
          targets: group.map((t) => ({
            windowId: t.windowId,
            tabId: t.tabId,
            url: t.url,
            long: t.long,
          })),
          round,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await appendDebugLog("browser_run_task", "whole capture command failed", {
          round,
          tabs: group.map((t) => t.tabId),
          error: message,
        });
        // The whole command failed = no image for any tab in the batch. Spread it into per-tab failure reasons and let the model change approach.
        return {
          snapshots: [],
          failures: group.map((t) => ({
            tabId: t.tabId,
            reason: explainSnapshotFailure(t.tabId, message),
            raw: message,
          })),
          windowPopups: new Map(),
          browserPopups: [],
        };
      }
    };

    const first = await shoot(targets);
    const retryable = first.failures.filter(
      (f) => !snapshotRetryIsPointless(f),
    );
    if (retryable.length === 0) {
      return await this.reshootStillLoading(round, targets, first, shoot);
    }

    await appendDebugLog("browser_run_task", "some tabs failed to capture, retrying those", {
      round,
      retrying: retryable.map((f) => f.tabId),
      giveUp: first.failures
        .filter((f) => snapshotRetryIsPointless(f))
        .map((f) => f.tabId),
    });
    await this.sleep(SNAPSHOT_RETRY_DELAY_MS);

    const again = await shoot(
      targets.filter((t) => retryable.some((f) => f.tabId === t.tabId)),
    );

    const merged: SnapshotBatchResult = {
      snapshots: [...first.snapshots, ...again.snapshots],
      // Failures not worth retrying from the first pass, plus those that failed again on recapture.
      failures: [
        ...first.failures.filter((f) => snapshotRetryIsPointless(f)),
        ...again.failures,
      ],
      // Take the window popups from the recapture; keep the first pass's for everything else.
      windowPopups: new Map([...first.windowPopups, ...again.windowPopups]),
      browserPopups: again.browserPopups.length
        ? again.browserPopups
        : first.browserPopups,
    };
    return await this.reshootStillLoading(round, targets, merged, shoot);
  }

  /**
   * Recapture a snapshot that carried a loadingMessage — that sentence means "the deadline
   * passed while the page was still loading, so I captured anyway", and what was captured is
   * half-built: controls are not mounted yet, the model cannot find its target and settles for
   * a neighbouring number.
   *
   * The measured cost of that frame: after navigating to Ctrip's home page the first frame had
   * not finished loading, and round three ran into "emsn 58 is covered by another element" —
   * a wasted round. One recapture costs about 200ms.
   *
   * Only one extra attempt: if it is still loading the second time, hand it over and let the
   * model call browserWait itself rather than wrestling a slow site here.
   */
  private async reshootStillLoading(
    round: number,
    targets: Array<{ windowId: string; tabId: string; url: string }>,
    done: SnapshotBatchResult,
    shoot: (
      group: Array<{ windowId: string; tabId: string; url: string }>,
    ) => Promise<SnapshotBatchResult>,
  ): Promise<SnapshotBatchResult> {
    const loading = done.snapshots.filter((s) => s.loadingMessage);
    if (loading.length === 0) {
      return done;
    }
    const group = targets.filter((t) =>
      loading.some((s) => s.tabId === t.tabId),
    );
    await appendDebugLog("browser_run_task", "page still loading, re-shooting those tabs", {
      round,
      tabs: group.map((t) => t.tabId),
    });
    await this.sleep(SNAPSHOT_RETRY_DELAY_MS);
    const again = await shoot(group);

    // If the recapture fails, keep the first half-built image: an image beats no image.
    const replaced = new Set(again.snapshots.map((s) => s.tabId));
    return {
      snapshots: [
        ...done.snapshots.filter((s) => !replaced.has(s.tabId)),
        ...again.snapshots,
      ],
      failures: done.failures,
      windowPopups: new Map([...done.windowPopups, ...again.windowPopups]),
      browserPopups: again.browserPopups.length
        ? again.browserPopups
        : done.browserPopups,
    };
  }

  /**
   * Fetch the browser layout once, retrying once on failure — nothing downstream is possible if
   * this step fails.
   *
   * If it still fails, throw with the command name, so "cannot read the browser's state" does
   * not present itself as some later step failing inexplicably.
   */
  private async readLayout(round: number): Promise<WindowInfo[]> {
    try {
      return await browserGetWindowInfo(this.cdp);
    } catch (first) {
      const message = first instanceof Error ? first.message : String(first);
      await appendDebugLog("browser_run_task", "layout fetch failed, retrying once after 1s", {
        round,
        error: message,
      });
      await this.sleep(Math.min(SNAPSHOT_RETRY_DELAY_MS, 1000));
      try {
        return await browserGetWindowInfo(this.cdp);
      } catch (second) {
        const m2 = second instanceof Error ? second.message : String(second);
        throw new Error(
          `Failed to read the browser layout (browserGetWindowInfo failed twice in a row: ${m2}). Without the layout there is no way to know which tabs exist, so the task cannot continue`,
        );
      }
    }
  }

  /**
   * decide: call the model for a plan. vllm.decide already handles "do not retry a quota error
   * -> fail the primary over to a backup and stay there -> a fatal throw when the last endpoint
   * fails". Failures propagate up and exit fatally. Returns a RuntimePlan (without the paused wrapper).
   */
  private async *decide(
    round: number,
    observation: RuntimeObservation | undefined,
  ): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    yield this.createStepUpdate(round, "decide", "Calling vllm.decide");
    await appendDebugLog("browser_run_task", "about to call vllm.decide", {
      round,
      snapshotCount: observation?.snapshots.length ?? 0,
      historyCount: this.memory.getSnapshot().history.length,
      // No plan exists yet here, so this records the state as of the previous round.
      lastTargetPath: this.memory.getSnapshot().latestTargetPath ?? null,
      consecutiveSameTargetCount:
        this.memory.getSnapshot().consecutiveSameTargetCount,
    });

    const state = this.memory.getSnapshot();
    // With every model down a person cannot help either, so a throw here ending the task is right.
    const rawPlan = await this.vllm.decide({
      round,
      userTask: this.args.task,
      currentDescriptionEx: state.currentDescriptionEx || "none",
      observation,
      target:
        state.latestWindowId && state.latestTabId
          ? { windowId: state.latestWindowId, tabId: state.latestTabId }
          : undefined,
      state,
    });
    const plan = this.enforceRejectedLimit(this.enforceNoProgress(this.enforceGuardrails(rawPlan)));
    // The model's whole-page summary is filed against the page it looked at this round. If it
    // saw no page, drop it: filing it against the wrong page is worse than not having it, since
    // it would have the model act on an unrelated summary on another page.
    if (plan.page_abstract) {
      this.memory.recordPageAbstract(plan.page_abstract);
      // Say so when one is stored. The model writes two or three in a whole task, buried in the
      // plan JSON where they are nearly invisible, and "did it actually write one" is the one
      // thing worth knowing when checking this feature.
      await appendDebugLog("browser_run_task", "page summary saved", {
        round,
        url: this.memory.getSnapshot().currentPageUrl ?? null,
      });
      yield this.createStepUpdate(
        round,
        "decide",
        `Page summary saved: ${plan.page_abstract}`,
      );
    }
    const treeParse = taskTreeParseStats(plan.task_tree_overview);
    // Most lines failing to yield a path = collapsing is doing essentially nothing, silently
    // (see PATH_LINE in runtime_task_tree.ts). Nobody compares the two taskTreeParse numbers in
    // the log on their own, so this says it out loud — once per task, since once the condition
    // holds it holds every round.
    if (
      !this.warnedTreeUnparsable &&
      treeParse.total > 0 &&
      treeParse.unparsed * 2 > treeParse.total
    ) {
      this.warnedTreeUnparsable = true;
      await appendDebugLog(
        "browser_run_task",
        "task tree mostly unparsable, compaction is doing nothing",
        {
          round,
          ...treeParse,
        },
      );
    }
    await appendDebugLog("browser_run_task", "vllm.decide finished", {
      round,
      currentPath: plan.current_executing_step.path,
      currentStatus: plan.current_executing_step.status,
      nextPath: plan.next_step_detail.path,
      isPaused: plan.next_step_detail.is_paused,
      allTaskIsComplete: plan.all_task_is_complete,
      actions: plan.next_step_detail.action_calls?.map((c) => c.function) ?? null,
      targetRepeat: this.memory.targetRepeatIfAdopted(
        plan.next_step_detail.path,
      ),
      // targetRepeat only rises while this is true; diagnosing "why did it stop / why did it not"
      // needs both numbers together.
      pageUnchanged: this.memory.getSnapshot().pageUnchanged,
      // For observation: how many different child nodes the model has used under one parent.
      // Expanding is what the prompt asks for, so this rises anyway; read it together with
      // pageUnchanged — rising while the page does not move is manufacturing the look of progress.
      siblingsUnderParent: this.memory.siblingCountFor(
        plan.next_step_detail.path,
      ),
      // For observation: how many task tree lines yield no path. Regularly non-zero = the model
      // changed its writing format and collapsing is wasted (the fallback is to keep, so nothing
      // is deleted wrongly, it just saves nothing) — and that is the signal to make
      // task_tree_overview structured data.
      taskTreeParse: treeParse,
    });
    yield this.createStepUpdate(round, "decide", "vllm.decide finished", {
      plan,
    });
    return plan;
  }

  /**
   * Run a batch of actions in order, stopping at the first failure.
   *
   * Three rules, all about when to stop:
   * 1. **On failure**, dropping the rest — the page is probably not what the model thought.
   * 2. **After an action that changes the page or a tab** (see isBatchTerminatingAction): every
   *    emsn in the snapshot the batch was planned against is then void.
   * 3. **Wait once after the batch**, not per action. This is where batching saves its time.
   *
   * Every step's result is numbered for the model: it needs to know how far it got, which one
   * failed, and why the rest did not run.
   */
  private async *runBatch(
    round: number,
    batch: RuntimeActionCall[],
    overflow: number,
    target: { windowId: string; tabId: string },
    /** The emsn of the clicks dropped by dropRedundantFocusClicks, which the model must be told about. */
    droppedFocusClicks: string[] = [],
  ): AsyncGenerator<
    RuntimeEvent,
    {
      windowId: string;
      tabId: string;
      text: string;
      executed: number;
      pageChanged: boolean;
      handedToHuman: boolean;
    },
    void
  > {
    let { windowId, tabId } = target;
    const lines: string[] = [];
    let executed = 0;
    let pageChanged = false;
    let handedToHuman = false;
    let stopReason = "";

    for (const [i, actionCall] of batch.entries()) {
      const label = `Action ${i + 1} (${actionCall.function})`;
      // Actions the runtime answers itself are intercepted here: they read the task history page
      // records, which should not pass through the executor (that layer only talks to the browser).
      if (RUNTIME_ANSWERED_ACTIONS.has(actionCall.function)) {
        const answer = this.answerHistoryQuery(actionCall);
        lines.push(`${label}: ${answer}`);
        executed += 1;
        continue;
      }
      try {
        // Hand this round's layout to the executor, to validate a params.tabId the model names.
        const outcome = await this.executor.execute(
          actionCall,
          { windowId, tabId },
          this.lastLayout,
          this.snapshotIds,
          this.emsnSets,
        );
        if (outcome.targetUpdate?.windowId) {
          windowId = outcome.targetUpdate.windowId;
        }
        if (outcome.targetUpdate?.tabId) {
          tabId = outcome.targetUpdate.tabId;
        }
        if (outcome.targetUpdate) {
          this.memory.updateTarget(windowId, tabId);
        }
        executed += 1;
        lines.push(`${label}: ${outcome.text}`);
        handedToHuman = outcome.humanControl === true;
      } catch (error) {
        // A failed action is not fatal: record it as a failure result, and the next decide sees it and changes approach.
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`${label} failed: ${message}`);
        await appendDebugLog("browser_run_task", "batch stopped (action failed)", {
          round,
          index: i + 1,
          action: actionCall.function,
          error: message,
        });
        stopReason = `${label} failed, so the remaining ${batch.length - i - 1} action(s) were not executed. A failed step usually means the page is not what you thought it was, and carrying on would only double down on a wrong belief. Re-judge from this round new screenshot`;
        break;
      }

      if (isBatchTerminatingAction(actionCall.function)) {
        pageChanged = true;
        const rest = batch.length - i - 1;
        if (rest > 0) {
          stopReason = `${label} changes the page or whether the tab exists (navigation, closing, handover), which voids every emsn in that snapshot, so the remaining ${rest} action(s) were not executed. If you still need them, give them again next round based on the new screenshot`;
        }
        break;
      }
      if (handedToHuman) {
        break;
      }
    }

    if (droppedFocusClicks.length) {
      lines.push(
        `(dropped the browserClick before typing into emsn ${droppedFocusClicks.join(", ")}: ` +
          `browserInputText focuses the field itself, and on a field that opens a panel — a date ` +
          `box, for one — that click sends the focus to the panel and the typing then fails. ` +
          `Just give the browserInputText next time)`,
      );
    }
    if (overflow > 0) {
      lines.push(
        `(you gave ${batch.length + overflow} actions; at most ${MAX_ACTIONS_PER_ROUND} run in one round, so the last ${overflow} were not executed)`,
      );
    }
    if (stopReason) {
      lines.push(`[BATCH STOPPED] ${stopReason}`);
    }

    return {
      windowId,
      tabId,
      text: lines.join("\n"),
      executed,
      pageChanged,
      handedToHuman,
    };
  }

  /** queryHistoryPage: page through the task history page records or search them by keyword; the result is returned as an action result. */
  private answerHistoryQuery(call: RuntimeActionCall): string {
    const p = (call.params ?? {}) as Record<string, unknown>;
    // null, an empty string and a non-number all count as "not given": Number(null) is 0, and
    // following that 0 clamps limit to 1, so the model gets one record when it specified nothing.
    const num = (raw: unknown): number | undefined => {
      if (typeof raw !== "number" && typeof raw !== "string") return undefined;
      if (typeof raw === "string" && !raw.trim()) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const { recorded, matched, offset, hits } = this.memory.queryPages({
      keyword: typeof p.keyword === "string" ? p.keyword : undefined,
      offset: num(p.offset),
      limit: num(p.limit),
    });
    if (!hits.length) {
      return recorded === 0
        ? "No page has been recorded for this task yet."
        : matched > 0
          ? `${matched} page(s) matched, all before offset ${offset} (${recorded} recorded).`
          : `No page matched (${recorded} recorded).`;
    }
    const body = hits
      .map(
        (page) =>
          `- ${page.title || "(untitled)"} | ${page.url} | rounds ${page.firstRound}-${page.lastRound}` +
          (page.abstract ? `\n  ${page.abstract}` : "\n  (no summary written for this page)"),
      )
      .join("\n");
    const shown = `${offset + 1}-${offset + hits.length} of ${matched}`;
    return `Recorded pages ${shown}:\n${body}`;
  }

  /**
   * The single entry point for a pause. Four ways out:
   *   the runtime intercepted something (the model used a deleted or renamed action) -> ask
   *     nobody; feed the refusal back into the history as an action failure and it picks
   *     another next round. Repeat offences end in a pause: see enforceRejectedLimit.
   *   the same decision has already been asked -> do not ask again; feed that answer back and carry on.
   *   a person answered -> the answer goes into memory, the pause flag is cleared, carry on.
   *   nobody could be asked -> hand to handlePause to finish (a sensitive action ends normally,
   *     everything else throws and terminates).
   */
  private async *settlePause(
    plan: RuntimePlan,
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<RuntimeEvent, { done: boolean; plan: RuntimePlan }, void> {
    if (isInterceptedPause(plan)) {
      const note = plan.next_step_detail.description;
      this.memory.appendActionRejected(round, plan, note);
      await appendDebugLog("browser_run_task", "action name rejected, feeding it back", {
        round,
        note,
      });
      yield this.createStepUpdate(round, "act", `Rejected before execution: ${note}`);
      return { done: false, plan: this.clearPause(plan) };
    }
    // The same **decision** has already been asked: do not ask again. The right thing is to act
    // on the answer, not to treat a person as a button that can be pressed repeatedly — feed
    // that answer back as a refusal and carry on.
    //
    // Only needs_answer is covered: a decision asked is asked, whereas "a person must work the
    // page" may genuinely need asking a second time for the same sentence (the site logged them
    // out, say), and that case must not be blocked.
    const answered =
      pauseKindOf(plan) === "needs_answer"
        ? this.memory.answerFor(plan.next_step_detail.description)
        : undefined;
    if (answered !== undefined) {
      const note = `You already asked this and the human answered: ${answered}. Act on that answer instead of asking again.`;
      this.memory.appendActionRejected(round, plan, note);
      await appendDebugLog("browser_run_task", "same question again, not asking", {
        round,
      });
      yield this.createStepUpdate(round, "decide", note);
      return { done: false, plan: this.clearPause(plan) };
    }
    const asked = yield* this.tryResolvePause(plan, round, windowId, tabId);
    if (asked.resolved) {
      return { done: false, plan: this.clearPause(plan) };
    }
    // Nobody could be asked: handlePause either throws and terminates or (for a sensitive action) finishes normally — both are endpoints.
    return {
      done: true,
      plan: yield* this.handlePause(
        plan,
        round,
        windowId,
        tabId,
        asked.handedOver,
      ),
    };
  }

  /** The pause is resolved: clear all of its flags and actions, and decide afresh next round. */
  private clearPause(plan: RuntimePlan): RuntimePlan {
    const resumed = structuredClone(plan);
    const next = resumed.next_step_detail;
    next.is_paused = false;
    delete next.action_calls;
    delete next.intercepted;
    delete next.sensitive;
    delete next.pause_kind;
    return resumed;
  }

  /**
   * First try to **resolve the pause in place**: ask a person, get an answer, carry on.
   *
   * Both kinds of pause ask a person; the only difference is whether the tab is handed over
   * first (an agent tab blocks physical keyboard and mouse, so without a handover "please work
   * the page" is an empty sentence):
   *   needs_answer        ask -> answer -> continue
   *   needs_human_on_page hand over -> ask "tell me when you are done" -> answer -> take control back -> continue
   *
   * When nobody can be asked (the host has no task-scoped elicitation, or the terminal is not
   * interactive), or the person gives no usable answer, it reports resolved=false and
   * handlePause ends the run.
   */
  private async *tryResolvePause(
    plan: RuntimePlan,
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<
    RuntimeEvent,
    { resolved: boolean; handedOver: boolean },
    void
  > {
    const ask = this.args.askHuman;
    if (!ask) {
      return { resolved: false, handedOver: false };
    }
    const kind = pauseKindOf(plan);
    const question = plan.next_step_detail.description;
    const handOver = kind === "needs_human_on_page";
    if (handOver) {
      yield* this.handToHuman(round, windowId, tabId);
    }
    yield this.createStepUpdate(
      round,
      "decide",
      handOver
        ? `Waiting for a human: ${question} (the tab is yours; say so when you are done)`
        : `Asking the human: ${question}`,
    );
    // An answer to the handover kind is only a confirmation, so an empty answer counts as "done";
    // for the decision kind it does not, since without a decision there is no way forward. Both
    // sentences go into the question, so the person knows what pressing Enter means.
    const prompt = handOver
      ? `${question}\n\nThe tab is yours now. Reply when you are done — an empty reply counts as done.`
      : `${question}\n\nAn empty reply means you are not deciding, and the task stops there.`;
    let answer: string | undefined;
    try {
      answer = await ask(prompt);
    } catch (error) {
      await appendDebugLog("browser_run_task", "asking the human failed", {
        round,
        error: error instanceof Error ? error.message : String(error),
      });
      answer = undefined;
    }
    await appendDebugLog("browser_run_task", "asked the human", {
      round,
      kind,
      handedOver: handOver,
      answered: answer !== undefined,
    });
    if (answer === undefined) {
      // An explicit refusal (q on the command line, decline/cancel from the host) or a failed
      // ask. A tab already handed over stays with the person; report handedOver so handlePause
      // does not hand it over a second time.
      return { resolved: false, handedOver: handOver };
    }
    const text = answer.trim();
    if (!text && !handOver) {
      // An empty answer to the decision kind means the person is not making that decision. We must not assume one for them; that would erase the point of asking.
      return { resolved: false, handedOver: false };
    }
    if (handOver) {
      yield* this.reclaimFromHuman(round, windowId, tabId);
    }
    this.memory.recordHumanAnswer(question, text || "done");
    yield this.createStepUpdate(round, "decide", `The human answered: ${text || "done"}`);
    return { resolved: true, handedOver: false };
  }

  /**
   * The finishing exit for a pause: **only reached when nobody could be asked**.
   *   A sensitive action (payment, password, a captcha...): hand over, then finish as a normal
   *     pause, giving the target back to the caller to resume.
   *   Everything else: hand over, then throw and terminate, with resume guidance in the error message.
   */
  private async *handlePause(
    plan: RuntimePlan,
    round: number,
    windowId: string,
    tabId: string,
    /** The asking step already handed the tab over; do not hand it over again. */
    alreadyHandedOver = false,
  ): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    if (isSensitivePause(plan)) {
      return yield* this.finishHandedToHuman(
        plan,
        round,
        windowId,
        tabId,
        alreadyHandedOver,
      );
    }
    if (!alreadyHandedOver) {
      yield* this.handToHuman(round, windowId, tabId);
    }
    throw new Error(this.buildPauseErrorMessage(plan, windowId, tabId));
  }

  /**
   * Hand the tab to a person (browserStartHumanControl). A failed handover is not fatal: the
   * pause information still has to be carried out, but the caller must see that the person
   * still cannot type, rather than us assuming a handover always succeeds.
   */
  private async *handToHuman(
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const res = await browserStartHumanControl(this.cdp, { windowId, tabId });
    await appendDebugLog("browser_run_task", "handing over to a human", {
      round,
      windowId,
      tabId,
      ok: res.ok,
      text: res.text,
    });
    yield this.createStepUpdate(
      round,
      "complete",
      res.ok
        ? `Tab handed to a human: ${res.text}`
        : `Handing over to a human failed; they may still be unable to type in this tab: ${res.text}`,
    );
  }

  /**
   * Rewrite the plan into a paused state after the model called browserStartHumanControl itself.
   * The plan still carries the action_call that just ran, and handing it over as is would have
   * the caller think there is another step to take.
   */
  private markHandedToHuman(
    plan: RuntimePlan,
    executionResult: string,
  ): RuntimePlan {
    const paused = structuredClone(plan);
    paused.next_step_detail.is_paused = true;
    paused.next_step_detail.description = `The tab was handed to a human as the model requested: ${executionResult}`;
    delete paused.next_step_detail.action_calls;
    // This is a pause, not a completion. With the main loop as it stands, nothing reaches here
    // with complete=true (all_task_is_complete is checked before the actions run and finishes
    // straight away), so this line is defensive: if that check ever moves, finish must not take
    // "complete" and closeTab — the tab is in a person's hands, that command is bound to fail,
    // and the cleanup switch would silently stop working.
    paused.all_task_is_complete = false;
    return paused;
  }

  /** Finish as a normal pause after a handover. The closeTab/closeWindow cleanup only runs on completion, so it cannot fire here by mistake. */
  private async *finishHandedToHuman(
    plan: RuntimePlan,
    round: number,
    windowId: string,
    tabId: string,
    alreadyHandedOver = false,
  ): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    if (!alreadyHandedOver) {
      yield* this.handToHuman(round, windowId, tabId);
    }
    return yield* this.finish(plan, round, windowId, tabId);
  }

  /**
   * Opening a resumed run: take control back from the person (browserStopHumanControl).
   * reason=none means the tab was never taken over, which is normal.
   * A tab the person took over themselves is theirs, and success=false when they refuse to give
   * it back — terminate immediately, since carrying on would fail at every step.
   */
  private async *reclaimFromHuman(
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const res = await browserStopHumanControl(this.cdp, { windowId, tabId });
    await appendDebugLog("browser_run_task", "taking control back", {
      round,
      windowId,
      tabId,
      ok: res.ok,
      text: res.text,
    });
    if (!res.ok) {
      throw new Error(`Cannot take control of the tab back, so the task cannot continue: ${res.text}`);
    }
    yield this.createStepUpdate(round, "bootstrap", res.text);
  }

  /** Finishing: clean up per the closeTab/closeBrowserWindow options and yield the completion event. */
  private async *finish(
    plan: RuntimePlan,
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    await appendDebugLog("browser_run_task", "task finished", {
      round,
      reason: plan.all_task_is_complete ? "complete" : "paused",
    });

    if (plan.all_task_is_complete) {
      if (this.args.closeTabWhenDone) {
        const closed = await browserCloseTab(this.cdp, { windowId, tabId });
        if (!closed.ok) {
          await appendDebugLog("browser_run_task", "closeTab failed", { error: closed.text });
        }
      }
      if (this.args.closeBrowserWindowWhenDone) {
        const closed = await browserCloseWindow(this.cdp, { windowId });
        if (!closed.ok) {
          await appendDebugLog("browser_run_task", "closeBrowserWindow failed", { error: closed.text });
        }
      }
    }

    yield {
      type: "complete",
      round,
      stage: "complete",
      message: plan.all_task_is_complete
        ? "Task complete"
        : `Task paused, a human is needed: ${plan.next_step_detail.description}`,
      plan,
    };
    return plan;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Build the detailed termination message for a model-initiated pause (description, trigger_reason, current result). */
  private buildPauseErrorMessage(
    plan: RuntimePlan,
    windowId: string,
    tabId: string,
  ): string {
    const desc = plan.next_step_detail.description;
    const result = plan.current_executing_step.result;
    return [
      `Task aborted: ${desc}`,
      result ? `Result so far: ${result}` : "",
      `The tab was handed to a human (windowId=${windowId}, tabId=${tabId}). Once they are done, call browser_run_task again with the same windowId and tabId to resume, adding humanReply to carry their answer in; the runtime takes control back automatically.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private isStopped(): boolean {
    return this.stopToken?.aborted ?? false;
  }

  /** Stopped by browser_stop_task: clean up per the flags (close the tab or window), yield the stop event and return a paused plan. */
  private async *stopAndFinish(
    round: number,
    windowId: string,
    tabId: string,
  ): AsyncGenerator<RuntimeEvent, RuntimePlan, void> {
    await appendDebugLog("browser_run_task", "task stopped manually", {
      round,
      closeTab: this.stopToken?.closeTab ?? false,
      closeBrowserWindow: this.stopToken?.closeBrowserWindow ?? false,
    });

    if (this.stopToken?.closeTab) {
      const closed = await browserCloseTab(this.cdp, { windowId, tabId });
      if (!closed.ok) {
        await appendDebugLog("browser_run_task", "closeTab failed while stopping", { error: closed.text });
      }
    }
    if (this.stopToken?.closeBrowserWindow) {
      const closed = await browserCloseWindow(this.cdp, { windowId });
      if (!closed.ok) {
        await appendDebugLog("browser_run_task", "closeBrowserWindow failed while stopping", { error: closed.text });
      }
    }

    const plan = this.buildStoppedPausePlan(round);
    yield {
      type: "complete",
      round,
      stage: "complete",
      message: "Task stopped manually via browser_stop_task.",
      plan,
    };
    return plan;
  }

  private buildStoppedPausePlan(round: number): RuntimePlan {
    const state = this.memory.getSnapshot();
    const lastHistory = state.history[state.history.length - 1];
    const path = lastHistory?.path ?? `${round}`;
    return {
      task_tree_overview:
        state.taskTreeOverview || "1. Current task ([NEXT STEP])",
      current_executing_step: {
        path,
        description: lastHistory?.description ?? "Task in progress",
        status: "partial",
        result: "Task was stopped manually.",
      },
      next_step_detail: {
        path,
        description: "Stopped manually via browser_stop_task; waiting for a human to continue.",
        status: "[NEXT STEP]",
        is_paused: true,
      },
      all_task_is_complete: false,
      complete_reason: "",
    };
  }

  /**
   * The deadlock backstop: force a pause when the same "next step" appears too many rounds running.
   *
   * The prompt already asks the model to pause itself after REPEAT_THRESHOLD rounds without
   * progress (runtime_vllm.ts), but measurably weaker models do not — one changed emsn every
   * round, claimed the previous step "completed" every round, and spun on the same leaf until
   * the round budget ran out, with the page unchanged through all 6 of them.
   *
   * The rule deliberately uses the next step's path rather than the model's self-reported
   * completion: whatever it claims does not change whether the next thing it wants to do has
   * changed. (A count of the self-reported status resets every round for such a model.)
   */
  private enforceNoProgress(plan: RuntimePlan): RuntimePlan {
    if (plan.all_task_is_complete || plan.next_step_detail.is_paused) {
      return plan;
    }
    const repeat = this.memory.targetRepeatIfAdopted(
      plan.next_step_detail.path,
    );
    if (repeat <= MAX_SAME_TARGET_ROUNDS) {
      return plan;
    }
    const stuck = structuredClone(plan);
    stuck.next_step_detail.is_paused = true;
    stuck.next_step_detail.description = `The next step has been ${plan.next_step_detail.path} (${plan.next_step_detail.description}) for ${repeat} rounds running with no progress on the page. The runtime judged this stuck and paused`;
    delete stuck.next_step_detail.action_calls;
    return stuck;
  }

  /** Rounds in a row whose plan the runtime rejected before execution (enforceRejectedLimit). */
  private rejectedRounds = 0;

  /**
   * The backstop enforceNoProgress cannot be: a rejected action name becomes a paused plan, which
   * it skips, so a model writing the same deleted action every round would spend the whole round
   * budget. MAX_SAME_TARGET_ROUNDS rejections in a row turn into a pause for a person.
   */
  private enforceRejectedLimit(plan: RuntimePlan): RuntimePlan {
    if (!isInterceptedPause(plan)) {
      this.rejectedRounds = 0;
      return plan;
    }
    this.rejectedRounds += 1;
    if (this.rejectedRounds < MAX_SAME_TARGET_ROUNDS) return plan;
    const stuck = structuredClone(plan);
    delete stuck.next_step_detail.intercepted;
    delete stuck.next_step_detail.action_calls;
    stuck.next_step_detail.description = `The model gave an action the runtime rejects ${this.rejectedRounds} rounds running (last: ${plan.next_step_detail.description}). The runtime judged this stuck and paused`;
    return stuck;
  }

  private enforceGuardrails(plan: RuntimePlan): RuntimePlan {
    const guarded = structuredClone(plan);

    // A plan for a completed task is not rewritten. Without this line, a booking task that
    // finished successfully would, merely by mentioning "pay" in its description, return a plan
    // carrying both all_task_is_complete=true and is_paused=true — two contradictory flags —
    // with the description replaced by "a person must complete this step". The main loop would
    // not take the wrong branch (completion is checked before pausing), but the plan the caller
    // receives contradicts itself.
    if (guarded.all_task_is_complete) {
      return guarded;
    }

    // A pause the runtime produced by interception is passed through untouched. Otherwise the
    // two collide: an interception reason contains words like "deleted" ("getComputedLabel has
    // been deleted...") and "delete" is in the sensitive list below, so one mistyped action name
    // would be rewritten as "this is a sensitive action" and the description shown to a person
    // would be completely wrong.
    if (isInterceptedPause(guarded)) {
      return guarded;
    }

    // Intent words are matched only against the two descriptions ("what I am about to do");
    // credential words are matched against result ("what I can see") as well. For why the two
    // are separated see runtime_sensitive.ts: every Ctrip page has a Sign in button in the top
    // right, and matching that against result would pause wrongly every round.
    const hit = findSensitive(
      {
        descriptions: [
          guarded.next_step_detail.description,
          guarded.current_executing_step.description,
        ],
        results: [guarded.current_executing_step.result],
      },
      this.sensitiveWords,
    );
    if (hit) {
      guarded.next_step_detail.is_paused = true;
      guarded.next_step_detail.sensitive = true;
      // Put the matched word into the wording. "Paused because it mentioned 'sign in'" is far
      // more useful than "this is a sensitive action" — when it fires wrongly you can see at a
      // glance where, and being a heuristic it is bound to fire wrongly sometimes.
      guarded.next_step_detail.description =
        `A human has to do this step, because it mentions "${hit}": ` +
        `The planned next step was "${guarded.next_step_detail.description}". ` +
        `Ask the user to do it by hand and confirm before continuing`;
      delete guarded.next_step_detail.action_calls;
    }

    return guarded;
  }

  /**
   * The sensitive word lists: the defaults plus any config override, so a missed word can be
   * added without a release. A miss is costly: the deadlock backstop catches it in the end, but
   * a backstop can only say "stuck", never the real reason.
   */
  private readonly sensitiveWords: SensitiveWords = {
    ...DEFAULT_SENSITIVE_WORDS,
    ...getSensitiveWords(),
  };
}

export async function runBrowserTaskToCompletion(
  cdp: CdpClient,
  args: BrowserRunTaskArgs,
): Promise<RuntimePlan> {
  const runtime = new BrowserRunTaskRuntime(cdp, args);
  const iterator = runtime.run();
  let finalPlan: RuntimePlan | undefined;

  while (true) {
    const step = await iterator.next();
    if (step.done) {
      finalPlan = step.value;
      break;
    }
  }

  if (!finalPlan) {
    throw new Error("browser_run_task returned no final result");
  }

  return finalPlan;
}

function createProgressNotification(
  taskId: string,
  eventIndex: number,
  event: RuntimeEvent,
) {
  return {
    method: "notifications/progress" as const,
    params: {
      progressToken: taskId,
      progress: eventIndex,
      message: JSON.stringify({
        type: event.type,
        round: event.round,
        stage: event.stage,
        message: event.message,
        plan: event.plan,
        executionResult: event.executionResult,
      }),
    },
  };
}

/**
 * The MCP side of "ask a person one question": through elicitation, **without ending the task**.
 *
 *   updateTaskStatus(input_required) -> elicitInput(relatedTask) -> updateTaskStatus(working)
 *
 * The capability tested is the **task-scoped** `tasks.requests.elicitation.create`, not plain
 * `elicitation`: with taskSupport="optional" the SDK creates a task internally even when the
 * client did not ask for one, so every question here carries relatedTask. A host without it gets
 * undefined and the runtime falls back to "finish and carry the question out", rather than
 * sending a request nobody catches and turning the question into a hang.
 *
 * decline / cancel returns undefined — not an answer. accept with nothing written returns an
 * empty string, which is a valid confirmation for the "work the page" kind.
 */
export function makeMcpAskHuman(
  server: McpServer,
  taskStore: {
    updateTaskStatus: (
      id: string,
      status: TaskStatus,
      message?: string,
    ) => Promise<void>;
  },
  taskId: string,
): ((question: string) => Promise<string | undefined>) | undefined {
  const caps = server.server.getClientCapabilities();
  if (!caps?.tasks?.requests?.elicitation?.create) {
    void appendDebugLog("browser_run_task", "host cannot be asked anything", {
      taskId,
      elicitation: !!caps?.elicitation,
      taskScopedElicitation: false,
    });
    return undefined;
  }
  return async (question: string): Promise<string | undefined> => {
    await taskStore.updateTaskStatus(taskId, "input_required", question);
    try {
      const result = await server.server.elicitInput(
        {
          mode: "form",
          message: question,
          requestedSchema: {
            type: "object",
            properties: {
              answer: {
                type: "string",
                title: "Answer",
                description: "Your answer; the task carries on with it.",
              },
            },
            required: ["answer"],
          },
        },
        { relatedTask: { taskId } },
      );
      // decline / cancel is an explicit refusal -> undefined (the runtime finishes as "nobody to ask").
      // accept with empty content -> an empty string: that is a confirmation, and how to read it
      // is up to the runtime and the kind of pause.
      if (result.action !== "accept") {
        return undefined;
      }
      const answer = result.content?.answer;
      return typeof answer === "string" ? answer.trim() : "";
    } finally {
      await taskStore.updateTaskStatus(taskId, "working", "browser_run_task is running");
    }
  };
}

async function runBrowserTaskAsStreamingTask(
  server: McpServer,
  cdp: CdpClient,
  args: BrowserRunTaskArgs,
  taskId: string,
  stopToken?: StopToken,
): Promise<RuntimePlan> {
  const runtime = new BrowserRunTaskRuntime(cdp, args, stopToken);
  const iterator = runtime.run();
  let eventIndex = 0;

  while (true) {
    const step = await iterator.next();
    if (step.done) {
      await appendDebugLog("browser_run_task", "streaming task finished", {
        taskId,
      });
      return step.value;
    }

    eventIndex += 1;
    await appendDebugLog("browser_run_task", "progress pushed", {
      taskId,
      eventIndex,
      stage: step.value.stage,
      round: step.value.round,
    });
    await server.server.notification(
      createProgressNotification(taskId, eventIndex, step.value),
      { relatedTask: { taskId } },
    );
  }
}

export function registerRuntimeBrowserRunTaskTool(
  server: McpServer,
  cdp: CdpClient,
): void {
  void appendDebugLog("browser_run_task", "registerToolTask", {
    toolName: "browser_run_task",
  });

  server.experimental.tasks.registerToolTask(
    "browser_run_task",
    {
      // Describe behaviour, not protocol or internals. The host's model and the user read
      // this text; words like "runtime loop", "VLLM" or "elicitation" mean nothing to them
      // and leave them unable to tell how the tool will behave.
      description:
        "Carry out a whole web task in a real browser and report what happened. This takes " +
        "minutes, not seconds, and reports progress as it goes. Describe the task in plain " +
        "language; it works out the steps itself. If it hits a login, a captcha or a payment " +
        "screen it stops and hands the browser to the person, then picks up where it left off " +
        "once they are done. Needs a vision model configured (EMBIODY_VLLM_*); for a small job " +
        "you can drive the browser yourself with browser_take_snapshot / browser_click / " +
        "browser_input_text instead, which needs no model.",
      inputSchema: BrowserRunTaskInputSchema,
      execution: {
        taskSupport: "optional",
      },
    },
    {
      async createTask(args, { taskStore, taskRequestedTtl }) {
        await appendDebugLog("browser_run_task", "createTask called", {
          taskRequestedTtl,
        });

        const task = await taskStore.createTask({
          ttl: taskRequestedTtl,
        });
        await appendDebugLog("browser_run_task", "createTask", {
          taskId: task.taskId,
        });

        const stopToken = registerTask(task.taskId);

        void (async () => {
          try {
            await taskStore.updateTaskStatus(
              task.taskId,
              "working",
              "browser_run_task is running",
            );

            const plan = await runBrowserTaskAsStreamingTask(
              server,
              cdp,
              {
                ...args,
                askHuman: makeMcpAskHuman(server, taskStore, task.taskId),
              },
              task.taskId,
              stopToken,
            );

            // A task returning while paused is **not completed**: this path is only reached when
            // the host could not be asked, and the task really is unfinished. Of the two terminal
            // states, completed would be a lie, so it lands on failed and hands over both the
            // question and the plan — the host calls again with humanReply.
            const paused = plan.next_step_detail.is_paused;
            await taskStore.storeTaskResult(
              task.taskId,
              paused ? "failed" : "completed",
              {
                content: [
                  {
                    type: "text",
                    text: paused
                      ? `A human is needed and this host cannot be asked mid-task: ${plan.next_step_detail.description}\n\nCall browser_run_task again with the same windowId/tabId plus humanReply to carry the answer in.\n\n${JSON.stringify(plan, null, 2)}`
                      : JSON.stringify(plan, null, 2),
                  },
                ],
                isError: paused ? true : undefined,
              },
            );
            await appendDebugLog("browser_run_task", "storeTaskResult completed", {
              taskId: task.taskId,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await appendDebugLog("browser_run_task", "createTask failed internally", {
              taskId: task.taskId,
              error: message,
            });

            await server.server.notification(
              createProgressNotification(task.taskId, 999999, {
                type: "step_update",
                round: -1,
                stage: "complete",
                message: `browser_run_task failed internally: ${message}`,
              }),
              { relatedTask: { taskId: task.taskId } },
            );

            await taskStore.storeTaskResult(task.taskId, "failed", {
              content: [
                {
                  type: "text",
                  text: message,
                },
              ],
              isError: true,
            });
            await appendDebugLog("browser_run_task", "storeTaskResult failed", {
              taskId: task.taskId,
              error: message,
            });
          } finally {
            unregisterTask(task.taskId);
          }
        })();

        await appendDebugLog("browser_run_task", "createTask returned", {
          taskId: task.taskId,
        });
        return { task };
      },
      async getTask(_args, { taskId, taskStore }) {
        await appendDebugLog("browser_run_task", "getTask called", {
          taskId,
        });
        const task = await taskStore.getTask(taskId);
        await appendDebugLog("browser_run_task", "getTask returned", {
          taskId,
          task,
        });
        return task;
      },
      async getTaskResult(_args, { taskId, taskStore }) {
        await appendDebugLog("browser_run_task", "getTaskResult called", {
          taskId,
        });
        const result = (await taskStore.getTaskResult(taskId)) as CallToolResult;
        await appendDebugLog("browser_run_task", "getTaskResult returned", {
          taskId,
          isError: result?.isError ?? false,
        });
        return withInstallNotice(result);
      },
    },
  );
}

export function registerBrowserStopTaskTool(server: McpServer): void {
  void appendDebugLog("browser_stop_task", "registerTool", { toolName: "browser_stop_task" });

  server.tool(
    "browser_stop_task",
    "Stop a running browser_run_task, by the ID that browser_run_task returned. The task stops " +
      "at the end of its current step and does not resume. Optionally closes the tab or the " +
      "whole browser window it was using; other windows are left alone. This is not the same " +
      "as cancelling the task at the protocol level: that is advisory and may be ignored, and " +
      "it cannot tidy up the browser. To stop a page loading rather than a task, use " +
      "browser_stop_loading.",
    {
      taskId: z.string().describe("Task ID returned by browser_run_task."),
      closeTab: z
        .boolean()
        .optional()
        .default(false)
        .describe("Close the tab the task was using after stopping."),
      closeBrowserWindow: z
        .boolean()
        .optional()
        .default(false)
        .describe("Close the browser window the task was using after stopping."),
    },
    async ({ taskId, closeTab, closeBrowserWindow }) => {
      const token = getTask(taskId);
      if (!token) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task ${taskId} does not exist or has already ended` }],
        };
      }
      token.closeTab = closeTab;
      token.closeBrowserWindow = closeBrowserWindow;
      token.aborted = true;
      await appendDebugLog("browser_stop_task", "stop requested", {
        taskId,
        closeTab,
        closeBrowserWindow,
      });
      return {
        content: [
          {
            type: "text",
            text: `Requested a stop for task ${taskId}${closeTab ? " (and close the tab)" : ""}${closeBrowserWindow ? " (and close the window)" : ""}. The runtime will exit at the end of the current stage.`,
          },
        ],
      };
    },
  );
}
