import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

// These constants are read from env once, when the module loads, so they must be set before the
// imports — otherwise a round waits 3-6 seconds after its actions and 60 seconds on a retry, and the
// tests become unusably slow.
const tmp = path.join(os.tmpdir(), "browserdo-test", String(process.pid));
process.env.EMBIODY_DEBUG_LOG = path.join(tmp, "debug.log");
process.env.EMBIODY_SNAPSHOT_DIR = path.join(tmp, "snapshots");
process.env.EMBIODY_POST_ACTION_WAIT_MS = "1";
process.env.EMBIODY_POST_NAVIGATE_WAIT_MS = "1";
process.env.EMBIODY_VLLM_MAX_RETRIES = "0";
process.env.EMBIODY_VLLM_RETRY_INTERVAL_MS = "1";
// The snapshot retry wait has to come down to 1ms too, or every case that retries really sleeps 2 seconds.
process.env.EMBIODY_SNAPSHOT_RETRY_DELAY_MS = "1";
process.env.EMBIODY_ROUND_INTERVAL_MS = "1";

const { BrowserRunTaskRuntime } = await import(
  "../../src/runtime_browser_run_task.js"
);
const { FakeCdp } = await import("../helpers/fake-cdp.js");
const { happyRoutes, navReply, snapshotReply, tabInfo, windowInfo, windowInfoReply } =
  await import("../helpers/fixtures.js");
const { StubVllm, makePlan } = await import("../helpers/stub-vllm.js");
const { MAX_ACTIONS_PER_ROUND } = await import("../../src/config.js");
import type { RuntimeEvent, RuntimePlan } from "../../src/runtime_types.js";

/** The tabIds named in one browserTakeSnapshot request, flattened in the order of the targets tree. */
function snapshotTabIds(call: { params: Record<string, unknown> }): string[] {
  const targets = (call.params.targets ?? []) as Array<{
    tabs?: Array<{ tabId?: unknown }>;
  }>;
  return targets.flatMap((t) => (t.tabs ?? []).map((x) => String(x.tabId)));
}

let endpoint = "";
let vllm: InstanceType<typeof StubVllm>;

/** Start a fake model that emits the given sequence of plans, and return the vllm arguments for the runtime. */
async function withPlans(plans: unknown[]) {
  await vllm?.stop();
  vllm = new StubVllm(plans);
  endpoint = await vllm.start();
  return {
    vllmEndpoint: endpoint,
    vllmModel: "stub",
    vllmApiKey: "stub-key",
    vllmApiStyle: "openai" as const,
  };
}

after(async () => {
  await vllm?.stop();
});

/** Run the runtime to the end, collecting the events and the final plan (or error). */
async function drain(
  runtime: InstanceType<typeof BrowserRunTaskRuntime>,
): Promise<{ events: RuntimeEvent[]; plan?: RuntimePlan; error?: Error }> {
  const events: RuntimeEvent[] = [];
  const it = runtime.run();
  try {
    while (true) {
      const step = await it.next();
      if (step.done) return { events, plan: step.value };
      events.push(step.value);
    }
  } catch (e) {
    return { events, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

const messages = (events: RuntimeEvent[]) => events.map((e) => e.message);
const hasMessage = (events: RuntimeEvent[], re: RegExp) =>
  events.some((e) => re.test(e.message));

describe("the runtime main loop: the debug log", () => {
  it("records URLs and steps, never the task text, page summaries or the model's words", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } }, description: "SECRET-STEP" }),
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } }, pageAbstract: "SECRET-ABSTRACT", overview: "1. SECRET-TREE" }),
      makePlan({ complete: true }),
    ]);
    const { error } = await drain(
      new BrowserRunTaskRuntime(new FakeCdp(happyRoutes()).asCdp(), { task: "SECRET-TASK", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    const log = fs.readFileSync(process.env.EMBIODY_DEBUG_LOG!, "utf8");
    assert.match(log, /browserNavigate/);
    assert.doesNotMatch(log, /SECRET-/);
  });
});

describe("the runtime main loop: bootstrap", () => {
  it("a brand-new task: find the working target -> browserShow(Maximized) -> a first planning round with no image -> run the action", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, events, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);

    const seq = cdp.methodSequence();
    assert.equal(seq[0], "Embiody.browserGetWindowInfo", "find the working target first");
    assert.equal(seq[1], "Embiody.browserShow", "then show and maximise");
    assert.equal(
      cdp.callsTo("Embiody.browserShow")[0].params.toState,
      "Maximized",
    );
    assert.ok(hasMessage(events, /First round is planning only/), messages(events).join("\n"));
  });

  it("no longer maximises through the standard Target.* CDP dance", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 1, ...args }),
    );
    assert.deepEqual(
      cdp.methodSequence().filter((m) => !m.startsWith("Embiody.")),
      [],
      "Target.getTargetInfo / Browser.setWindowBounds should be gone",
    );
  });

  it("at bootstrap, about:blank skips the capture (no point capturing an empty image)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 100 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({ tabs: [tabInfo({ tabId: "1001", url: "about:blank" })] }),
        ],
        success: true,
      }),
    });
    const { events } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    // Blankness is judged from **the url in the layout**, and decided before reaching the kernel —
    // the kernel is bound to answer "Failed to capture html." for about:blank, and spending a round trip
    // to obtain an error is pointless.
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      0,
      "a blank tab should never be sent for capture: " + messages(events).join(" | "),
    );
    assert.ok(
      hasMessage(events, /No tab could be captured/),
      messages(events).join("\n"),
    );
  });
});

describe("the runtime main loop: the landing url comes from the kernel's reply", () => {
  it("after a redirect, the empty-page test uses the real landing place", async () => {
    // about:blank is requested (which would be judged an empty page and skipped), but the kernel says it
    // landed on a real page — so capturing should proceed as usual. Trusting the requested url would
    // skip the capture forever.
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "about:blank" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserNavigate": () => navReply({ url: "https://real.test/landed" }),
    });
    const { events } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      1,
      "it landed on a real page and should be captured: " + messages(events).join(" | "),
    );
  });
});

describe("the runtime main loop: blankness is judged from the layout alone, never from state we keep", () => {
  // A url kept by the runtime drifts: after switching tabs it judges the new tab by the previous tab's
  // address. The layout is refetched every round and is the only authority on a tab's url.
  it("if the layout says a tab has content, capture it, even when the working tab is about:blank", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "about:blank" } } }),
      makePlan({ action: { function: "browserAddNewTab", params: { url: "https://real.test/" } } }),
      makePlan({ complete: true }),
    ]);
    let newTabExists = false;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserNavigate": () =>
        navReply({ url: "about:blank", loadStatus: "committed" }),
      "Embiody.browserNewTab": () => {
        newTabExists = true;
        // Deliberately no url: where it landed is unknown, and only the layout knows the truth.
        return navReply({ tabId: "2002", url: "", loadStatus: "failed" });
      },
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "about:blank" }),
              ...(newTabExists
                ? [
                    tabInfo({
                      tabId: "2002",
                      index: 1,
                      url: "https://real.test/",
                      isGhost: true,
                    }),
                  ]
                : []),
            ],
          }),
        ],
        success: true,
      }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    const snaps = cdp.callsTo("Embiody.browserTakeSnapshot");
    assert.ok(snaps.length >= 1, "a tab the layout says has content should be captured");
    assert.deepEqual(snapshotTabIds(snaps.at(-1)!), ["2002"]);
  });
});

describe("the runtime main loop: feeding the whole layout to the model", () => {
  it("the prompt lists every tab's tabId, address, can_go_back and so on", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            windowId: "900",
            tabs: [
              tabInfo({
                tabId: "1001",
                url: "https://a.test/",
                canGoBack: true,
                isAudible: true,
                isGhost: true,
              }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
    });
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Current browser layout/);
    assert.match(prompt, /tabId=1001/);
    assert.match(prompt, /tabId=1002/, "a tab that was not captured must still be listed, or the model cannot name it");
    assert.match(prompt, /can_go_back=true/);
    assert.match(prompt, /audible/);
    assert.match(prompt, /agent is using it/);
    assert.match(prompt, /current working tab/);
  });

  it("when the runtime chooses the capture tabs on the model's behalf it must say so (do not let it think it chose)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /You did not pick the tab captured this round/);
    assert.match(prompt, /snapshot_tabs/, "it must be told how to name them itself");
  });

  it("the layout failing twice in a row -> terminate carrying the command name (the layout is load-bearing and cannot be faked)", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => new Error("connection reset"),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "resume",
        maxRounds: 1,
        windowId: "900",
        tabId: "1001",
        ...args,
      }),
    );
    assert.ok(error);
    assert.match(error!.message, /Failed to read the browser layout/);
    assert.match(error!.message, /browserGetWindowInfo/);
    assert.equal(
      cdp.callsTo("Embiody.browserGetWindowInfo").length,
      2,
      "it should retry once",
    );
  });
});

describe("the runtime main loop: the model naming several tabs to capture", () => {
  it("snapshot_tabs naming two -> one command captures both", async () => {
    const args = await withPlans([
      makePlan({
        action: { function: "browserWait", params: { durationMs: 100 } },
        snapshotTabs: ["1001", "1002"],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "https://a.test/" }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
    });
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    const snaps = cdp.callsTo("Embiody.browserTakeSnapshot");
    assert.equal(snaps.length, 1, "two tabs should be merged into one command");
    assert.deepEqual(snapshotTabIds(snaps[0]), ["1001", "1002"]);
    // Each image gets its own section, with an explicit warning that emsn are not shared.
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Image 1 \/ tabId=1001/);
    assert.match(prompt, /Image 2 \/ tabId=1002/);
    assert.match(prompt, /numbered independently/);
  });

  // One round only: the long read is several times larger, so it must not stick.
  it('read_whole_page (even as the string "true") -> next capture is a long snapshot, the one after is not', async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 100 } }, readWholePage: "true" }),
      makePlan({ action: { function: "browserWait", params: { durationMs: 100 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    const long = cdp.callsTo("Embiody.browserTakeSnapshot").map((c) => {
      const targets = c.params.targets as Array<{ tabs: Array<{ longSnapshot?: boolean }> }>;
      return targets[0].tabs[0].longSnapshot === true;
    });
    // A fresh task plans its first round without a capture: the first capture follows the request, the second a plan without it.
    assert.deepEqual(long, [true, false]);
  });

  it("naming one invented tabId -> the valid one is captured and the invalid one reported as a reason", async () => {
    const args = await withPlans([
      makePlan({
        action: { function: "browserWait", params: { durationMs: 100 } },
        snapshotTabs: ["1001", "invented"],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 1);
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /not in this round layout/);
    assert.match(prompt, /invented/);
  });

  it("an action may carry params.tabId to say which tab it applies to (required with several images)", async () => {
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({
        action: { function: "browserWait", params: { durationMs: 1 } },
        // To act on 1002 it has to be captured first — a tab never captured has no snapshotId and the action is refused.
        snapshotTabs: ["1001", "1002"],
      }),
      makePlan({
        action: { function: "browserClick", params: { tabId: "1002", emsn: 7 } },
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "https://a.test/" }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(cdp.lastCall("Embiody.browserClick").params.tabId, "1002");
  });

  it("an action carrying an invented tabId -> the action does not run, and the existing tabs are listed for the model", async () => {
    const args = await withPlans([
      makePlan({
        action: { function: "browserClick", params: { tabId: "invented", emsn: 7 } },
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { events, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      0,
      "an unvalidated tabId must not be sent to the kernel",
    );
    assert.ok(
      hasMessage(events, /not in this round layout/),
      messages(events).join("\n"),
    );
  });
});
describe("the runtime main loop: a completed task is not rewritten by the sensitive check", () => {
  it("the description mentions payment but the task is complete -> finish as usual, not as a pause", async () => {
    // A booking task very likely mentions payment in the description as it finishes. Without this check the
    // returned plan would carry both all_task_is_complete=true and is_paused=true — two contradictory
    // flags — with the description replaced by "a person must complete this step". The main loop would not
    // take the wrong branch (completion is checked before pausing), but the plan the caller receives
    // contradicts itself, and the CLI prints it while MCP callers receive it too.
    const args = await withPlans([
      makePlan({ complete: true, description: "everything before the payment is done; the task is finished" }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error, events } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "book a ticket", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
    assert.equal(plan?.next_step_detail.is_paused, false, "it must not be turned into a pause");
    assert.equal(
      plan?.next_step_detail.description,
      "everything before the payment is done; the task is finished",
      "the description must be left as it is",
    );
    assert.ok(hasMessage(events, /Task complete/), messages(events).join(" | "));
    assert.equal(
      cdp.callsTo("Embiody.browserStartHumanControl").length,
      0,
      "a completed task must not hand the tab to a person",
    );
  });
});

describe("the runtime main loop: a sensitive-action pause hands the tab to a person", () => {
  it("the model trips a sensitive word -> startHumanControl -> finish as a pause (not simply end, locking the person out)", async () => {
    const args = await withPlans([
      makePlan({ description: "输入账号密码登录", action: null }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, events, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "sign in", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.next_step_detail.is_paused, true);
    // The wording must name the matched word: when it fires wrongly you can see where at a glance, and being a heuristic it is bound to sometimes.
    assert.match(plan!.next_step_detail.description, /A human has to do this step/);
    assert.match(plan!.next_step_detail.description, /"密码"/, "it must say which word");
    assert.match(
      plan!.next_step_detail.description,
      /输入账号密码登录/,
      "the original next step must be kept too, or the person cannot tell what it was trying to do",
    );

    const handoff = cdp.callsTo("Embiody.browserStartHumanControl");
    assert.equal(handoff.length, 1, "it must hand over, or in an agent tab the person cannot type at all");
    assert.equal(handoff[0].params.windowId, "900");
    assert.equal(handoff[0].params.tabId, "1001");
    assert.ok(hasMessage(events, /Tab handed to a human/), messages(events).join("\n"));
  });

  it("a failed handover still carries the pause out, but says plainly the person may still be unable to type", async () => {
    const args = await withPlans([
      makePlan({ description: "请输入支付密码", action: null }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserStartHumanControl": { success: false },
    });
    const { plan, events, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "pay", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.next_step_detail.is_paused, true);
    assert.ok(
      hasMessage(events, /Handing over to a human failed/),
      "a failed handover must be said out loud: " + messages(events).join("\n"),
    );
  });

  it("a sensitive pause never closes the tab or window (that cleanup only runs on completion)", async () => {
    const args = await withPlans([
      makePlan({ description: "输入验证码", action: null }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "verify",
        maxRounds: 2,
        closeTabWhenDone: true,
        closeBrowserWindowWhenDone: true,
        ...args,
      }),
    );
    assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 0);
    assert.equal(cdp.callsTo("Embiody.browserCloseWindow").length, 0);
  });

  it("a model-initiated pause (not sensitive) also hands over, with resume guidance in the error", async () => {
    const args = await withPlans([
      makePlan({ description: "two rounds without progress; a person should look", paused: true, action: null }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.ok(error, "a model-initiated pause still terminates by throwing");
    assert.match(error!.message, /Task aborted/);
    assert.match(error!.message, /windowId=900/);
    assert.match(error!.message, /tabId=1001/);
    assert.match(error!.message, /resume/);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
  });
});

describe("the runtime main loop: an intercepted action name is not a pause", () => {
  // The model writing a deleted action name is its own output error: nothing needs a person, and the
  // task must not terminate. The refusal is fed back into the history as an action failure, and it picks
  // another next round.
  for (const staleAction of [
    "browserWaitForElement",
    "browserStartup",
    "browserGetSemanticRole",
  ]) {
    it(`the model returning ${staleAction} -> the reason is fed back and the run continues`, async () => {
      const args = await withPlans([
        makePlan({ action: { function: staleAction, params: {} } }),
        makePlan({ complete: true }),
      ]);
      const cdp = new FakeCdp(happyRoutes());
      const { plan, error } = await drain(
        new BrowserRunTaskRuntime(cdp.asCdp(), {
          task: "a test",
          maxRounds: 4,
          ...args,
        }),
      );
      assert.equal(error, undefined, error?.message);
      assert.equal(plan?.all_task_is_complete, true, "one wrong action name must not terminate the task");
      assert.equal(
        cdp.callsTo("Embiody.browserStartHumanControl").length,
        0,
        "the tab must not be handed to a person: there is nothing here for one to do",
      );
      // The refusal has to enter the history, or the model cannot see it next round and writes it again.
      assert.match(vllm.lastUserPrompt(), /Rejected before execution/);
    });
  }

  it("writing a rejected action name round after round ends in a pause, not in the round budget", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserStartup", params: {} } }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 12, ...args }),
    );
    assert.ok(error);
    assert.match(error!.message, /rejects 3 rounds running/);
    assert.doesNotMatch(error!.message, /maximum of 12 rounds/);
  });

  it("a usable plan between rejections starts the count again", async () => {
    const rejected = () => makePlan({ action: { function: "browserStartup", params: {} } });
    const args = await withPlans([
      rejected(),
      rejected(),
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      rejected(),
      rejected(),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 12, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
  });

  it("by contrast: the model setting is_paused with nobody to ask still hands over and then terminates", async () => {
    const args = await withPlans([
      makePlan({
        description: "two rounds without progress; a person should look",
        paused: true,
        action: null,
      }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.ok(error);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
    assert.match(error!.message, /handed to a human/);
  });
});

describe("the runtime main loop: asking a person one question and carrying on in place", () => {
  /** Record what was asked and answer from a script. */
  const scripted = (answers: Array<string | undefined>) => {
    const asked: string[] = [];
    let i = 0;
    return {
      asked,
      askHuman: async (question: string) => {
        asked.push(question);
        return answers[i++];
      },
    };
  };

  it("needs_answer: no handover, and the answer goes into the prompt every round", async () => {
    const args = await withPlans([
      makePlan({
        description: "the outbound leg is chosen; shall I book a return too?",
        paused: true,
        pauseKind: "needs_answer",
        action: null,
      }),
      makePlan({ action: { function: "browserClick", params: { emsn: 1 } } }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["one way only, no return"]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "book a ticket",
        maxRounds: 6,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true, "with the answer in hand it should run to completion");
    assert.equal(human.asked.length, 1);
    assert.match(human.asked[0], /shall I book a return too/);
    // The question must say what an empty answer means, or the person does not know what pressing Enter does.
    assert.match(human.asked[0], /An empty reply means you are not deciding/);
    assert.equal(
      cdp.callsTo("Embiody.browserStartHumanControl").length,
      0,
      "this is only a question and the tab should not be handed over",
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Answers from the human/);
    assert.match(prompt, /one way only, no return/);
  });

  it("needs_human_on_page: hand over first, take control back after the answer", async () => {
    const args = await withPlans([
      makePlan({
        description: "this step needs you to sign in yourself",
        paused: true,
        pauseKind: "needs_human_on_page",
        action: null,
      }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["signed in"]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 6,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1, "it must hand over");
    assert.equal(cdp.callsTo("Embiody.browserStopHumanControl").length, 1, "it must take control back after the answer");
    // The question must tell the person "the tab is yours; say when you are done", or they do not know what to reply.
    assert.match(human.asked[0], /The tab is yours now/);
  });

  it("a missing pause_kind -> treated as needing a person on the page (the expensive side is recoverable)", async () => {
    const args = await withPlans([
      makePlan({ description: "a person should take a look", paused: true, action: null }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["had a look"]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 6,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
  });

  it("a sensitive action matching the keyword net -> hand over anyway, even when the model says an answer is enough", async () => {
    const args = await withPlans([
      makePlan({
        description: "点击去支付",
        paused: true,
        pauseKind: "needs_answer",
        action: null,
      }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["paid"]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "pay",
        maxRounds: 6,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
  });

  it("the person declines to answer -> as if nobody could be asked: hand over then terminate", async () => {
    const args = await withPlans([
      makePlan({
        description: "carry on?",
        paused: true,
        pauseKind: "needs_answer",
        action: null,
      }),
    ]);
    const human = scripted([undefined]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 4,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.ok(error, "with no answer it should end as if nobody could be asked");
    assert.match(error!.message, /handed to a human/);
  });

  it("'work the page' declined -> the tab stays handed over (once, not twice) and the run terminates", async () => {
    const args = await withPlans([
      makePlan({
        description: "this step needs you to sign in yourself",
        paused: true,
        pauseKind: "needs_human_on_page",
        action: null,
      }),
    ]);
    const human = scripted([undefined]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 4,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.ok(error);
    assert.match(error!.message, /handed to a human/);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1, "handed over before asking, and not again");
    assert.equal(cdp.callsTo("Embiody.browserStopHumanControl").length, 0, "the tab stays with the person");
  });

  it("asking itself failing (the host connection broke) counts as no answer, not as a crash", async () => {
    const args = await withPlans([
      makePlan({ description: "shall I book a return too?", paused: true, pauseKind: "needs_answer", action: null }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "book a ticket",
        maxRounds: 4,
        askHuman: async () => {
          throw new Error("transport closed");
        },
        ...args,
      }),
    );
    assert.ok(error);
    assert.match(error!.message, /Task aborted/, "it must end through the pause exit, carrying the resume guidance");
    assert.doesNotMatch(error!.message, /transport closed/);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
  });

  it("an empty answer to 'work the page' means done, and the run continues", async () => {
    const args = await withPlans([
      makePlan({
        description: "this step needs you to sign in yourself",
        paused: true,
        pauseKind: "needs_human_on_page",
        action: null,
      }),
      makePlan({ complete: true }),
    ]);
    const human = scripted([""]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 6,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true, "that answer was only ever a confirmation");
    assert.equal(cdp.callsTo("Embiody.browserStopHumanControl").length, 1, "control must still be taken back");
    assert.match(human.asked[0], /an empty reply counts as done/);
  });

  it("an empty answer to 'make a decision' means no decision, and it finishes as a pause", async () => {
    const args = await withPlans([
      makePlan({
        description: "shall I book a return too?",
        paused: true,
        pauseKind: "needs_answer",
        action: null,
      }),
    ]);
    const human = scripted([""]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "book a ticket",
        maxRounds: 4,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.ok(error, "without a decision there is no way forward, and we must not assume one");
    assert.match(error!.message, /handed to a human/);
  });

  it("the same question a second time -> stop bothering the person and feed the previous answer back", async () => {
    const question = "shall I book a return too?";
    const args = await withPlans([
      makePlan({ description: question, paused: true, pauseKind: "needs_answer", action: null }),
      // The model did not read the answer and asks the same question again.
      makePlan({ description: question, paused: true, pauseKind: "needs_answer", action: null }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["one way only"]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "book a ticket",
        maxRounds: 8,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(human.asked.length, 1, "the same question should reach a person only once");
    assert.match(vllm.lastUserPrompt(), /You already asked this/);
  });

  it("the same 'work the page' request may be asked twice — the site may have logged the person out", async () => {
    const request = "this step needs you to sign in yourself";
    const args = await withPlans([
      makePlan({ description: request, paused: true, pauseKind: "needs_human_on_page", action: null }),
      makePlan({ description: request, paused: true, pauseKind: "needs_human_on_page", action: null }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["signed in", "signed in again"]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 8,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(human.asked.length, 2, "a request to act must not be blocked by deduplication");
  });

  it("two different questions -> both answers are kept and both appear in the prompt", async () => {
    const args = await withPlans([
      makePlan({ description: "one way or return?", paused: true, pauseKind: "needs_answer", action: null }),
      makePlan({ description: "morning or afternoon?", paused: true, pauseKind: "needs_answer", action: null }),
      makePlan({ complete: true }),
    ]);
    const human = scripted(["one way", "morning"]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "book a ticket",
        maxRounds: 8,
        askHuman: human.askHuman,
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(human.asked.length, 2);
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /one way/);
    assert.match(prompt, /morning/);
  });

  it("a blank humanReply -> not treated as an answer, and that section is absent from the prompt", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 2,
        humanReply: "   ",
        ...args,
      }),
    );
    assert.doesNotMatch(vllm.lastUserPrompt(), /Answers from the human/);
  });

  it("humanReply: an answer carried in from a previous run is fed to the model every round", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 2,
        humanReply: "one way only",
        ...args,
      }),
    );
    assert.match(vllm.lastUserPrompt(), /Answers from the human/);
    assert.match(vllm.lastUserPrompt(), /one way only/);
  });
});

describe("the runtime main loop: task history page records", () => {
  const wait = () => ({ function: "browserWait", params: { durationMs: 1 } });

  it("the model's whole-page summary is stored against the current page and replayed to it next round", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      // The summary has to be written on a round **after** seeing a page: the planning-only first round has no snapshot and so no page to file it against.
      makePlan({
        action: wait(),
        pageAbstract: "Ctrip flight results: a search form at the top (one-way / return), the lower part not looked at yet",
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error, events } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    const prompt = vllm.lastUserPrompt();
    // Storing one must be visible in the terminal: the model writes two or three in a whole task, and buried in the plan JSON they are nearly impossible to spot.
    assert.ok(
      events.some(
        (e) =>
          e.stage === "decide" && e.message.startsWith("Page summary saved:"),
      ),
      "storing a summary produced no visible output",
    );
    assert.match(prompt, /The page you are on, as you summarised it/);
    assert.match(prompt, /one-way \/ return/);
    // It must be said that the summary may be incomplete, or the model uses a partial summary as a complete map.
    assert.match(prompt, /may be incomplete/);
  });

  it("a summary written during the planning-only first round is dropped — there is no page yet to file it against", async () => {
    const args = await withPlans([
      makePlan({ action: wait(), pageAbstract: "a summary written before seeing any page" }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.doesNotMatch(vllm.lastUserPrompt(), /a summary written before seeing any page/);
  });

  it("a changed URL adds a record, and the old page moves into the 'other pages' section", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      makePlan({ action: wait(), pageAbstract: "page one: the search entry" }),
      makePlan({ action: wait() }),
      makePlan({ complete: true }),
    ]);
    let calls = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      // After a few rounds the page moves to another URL.
      "Embiody.browserGetWindowInfo": () => {
        calls += 1;
        return calls >= 4
          ? windowInfoReply([
              windowInfo({
                tabs: [tabInfo({ url: "https://example.com/next", title: "next page" })],
              }),
            ])
          : windowInfoReply();
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 6, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Pages this task has visited/);
    assert.match(prompt, /page one: the search entry/, "the summary of the page we left must be kept");
  });

  it("queryHistoryPage is answered by the runtime, sends no CDP at all, and its result reaches the next round", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      makePlan({ action: wait(), pageAbstract: "flight results page, with a one-way toggle at the top" }),
      makePlan({ action: { function: "queryHistoryPage", params: { keyword: "one-way" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 6, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.calls.filter((c) => c.method.includes("queryHistoryPage")).length,
      0,
      "it is not a browser command and should have no call of that name",
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Recorded pages 1-1 of 1/);
    assert.match(prompt, /flight results page, with a one-way toggle at the top/);
  });

  it("no parameters means paging the list; junk parameters fall back to the defaults without giving fewer entries", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      makePlan({ action: wait(), pageAbstract: "page one's summary" }),
      makePlan({ action: wait() }),
      // null and unparsable strings both count as "not given": Number(null) is 0, and following that 0
      // clamps limit to 1, so the model gets one entry when it specified nothing.
      makePlan({
        action: {
          function: "queryHistoryPage",
          params: { limit: null, offset: "abc" },
        },
      }),
      makePlan({ complete: true }),
    ]);
    let calls = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => {
        calls += 1;
        return calls >= 4
          ? windowInfoReply([
              windowInfo({
                tabs: [tabInfo({ url: "https://example.com/next", title: "next page" })],
              }),
            ])
          : windowInfoReply();
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 7, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.match(vllm.lastUserPrompt(), /Recorded pages 1-2 of 2/, "both pages should be given");
  });

  it("a miss says so, and says how many pages are recorded in total", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      makePlan({
        action: { function: "queryHistoryPage", params: { keyword: "a word that never appeared" } },
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, ...args }),
    );
    assert.match(vllm.lastUserPrompt(), /No page matched \(1 recorded\)/);
  });

  it("an offset past the matches says they matched, not that nothing did", async () => {
    const args = await withPlans([
      makePlan({ action: wait() }),
      makePlan({ action: { function: "queryHistoryPage", params: { offset: 5 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, ...args }),
    );
    assert.match(vllm.lastUserPrompt(), /1 page\(s\) matched, all before offset 5 \(1 recorded\)/);
  });
});

describe("the runtime main loop: taking control back when resuming", () => {
  it("a resumed run calls stopHumanControl first, before anything else", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "resume",
        maxRounds: 1,
        windowId: "900",
        tabId: "1001",
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    const seq = cdp.methodSequence();
    const reclaim = seq.indexOf("Embiody.browserStopHumanControl");
    const show = seq.indexOf("Embiody.browserShow");
    assert.ok(reclaim >= 0, "a resumed run must take control back: " + seq.join(" -> "));
    assert.ok(reclaim < show, "taking control back must come before anything else: " + seq.join(" -> "));
  });

  it("a resumed run does not depend on target discovery: it works with an empty window list (the caller gives the target)", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      // Target discovery would throw on this empty list; the resume path must never reach it.
      "Embiody.browserGetWindowInfo": () => ({ windows: [], success: true }),
    });
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "resume",
        maxRounds: 1,
        windowId: "900",
        tabId: "1001",
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
    // The target really is the pair of ids that were passed in.
    assert.equal(cdp.lastCall("Embiody.browserShow").params.windowId, "900");
    assert.equal(
      cdp.lastCall("Embiody.browserStopHumanControl").params.tabId,
      "1001",
    );
  });

  it("the person refusing to give control back -> terminate at once rather than running doomed actions", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserStopHumanControl": {
        success: false,
        reason: "userTookOver",
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "resume",
        maxRounds: 1,
        windowId: "900",
        tabId: "1001",
        ...args,
      }),
    );
    assert.ok(error);
    assert.match(error!.message, /Cannot take control of the tab back/);
    assert.match(error!.message, /userTookOver/);
    // Terminate cleanly: no further capturing or deciding.
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 0);
  });

  it("reason=none (it was never taken over) does not affect a resumed run", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserStopHumanControl": { success: true, reason: "none" },
    });
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "resume",
        maxRounds: 1,
        windowId: "900",
        tabId: "1001",
        ...args,
      }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
  });
});

describe("the runtime main loop: the model handing over on its own", () => {
  it("the model calling browserStartHumanControl itself -> finish as a pause, sending no further doomed actions", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserStartHumanControl", params: {} } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(cdp.callsTo("Embiody.browserStartHumanControl").length, 1);
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      0,
      "observe must not run after a handover — everything but a snapshot fails and the round is wasted",
    );
    assert.equal(plan?.next_step_detail.is_paused, true, "this is a pause");
    assert.match(plan!.next_step_detail.description, /handed to a human/);
    assert.equal(
      plan?.next_step_detail.action_calls,
      undefined,
      "a pause and an action_call are mutually exclusive",
    );
  });

  it("the model marking completion and giving an action_call -> completion wins and the action does not run", async () => {
    // This is an existing rule of the main loop: all_task_is_complete is checked **before** the actions run.
    // Pinning it down, because it decides what actually happens to a batch of "action plus completion"
    // plans — for instance a model that says the task is done while also asking to hand the tab to a
    // person has that handover request dropped.
    const args = await withPlans([
      makePlan({
        action: { function: "browserStartHumanControl", params: {} },
        complete: true,
      }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
    assert.equal(
      cdp.callsTo("Embiody.browserStartHumanControl").length,
      0,
      "once completion is marked no action runs, and the handover request is dropped",
    );
  });
});

describe("the runtime main loop: a failed action is not fatal", () => {
  it("a failed navigation is recorded as this round's failure and the next round decides again", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserNavigate": () => navReply({ loadStatus: "failed" }),
    });
    const { plan, events, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    // The failure message carries its position in the batch (action N).
    assert.ok(
      hasMessage(events, /Action 1 \(browserNavigate\) failed/),
      messages(events).join("\n"),
    );
    assert.equal(plan?.all_task_is_complete, true, "progress is still possible after a failure");
  });

  it("a failed capture does not kill the round; it becomes a reason handed to the model", async () => {
    // A soft failure: the model gets the reason ("this tab is blank, navigate first") and the run
    // continues, so a single blank page cannot end the task.
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": () => new Error("Failed to capture html"),
    });
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, "failing to capture must not terminate the task");
    assert.equal(plan?.all_task_is_complete, true);
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /could not be captured/);
    assert.match(prompt, /blank page/, "the model needs something it can change approach on");
  });

  it("a deterministic failure is not retried (retrying just wastes two seconds)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": () => new Error("No Tab found"),
    });
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      1,
      "No Tab found is deterministic and must not be retried",
    );
  });

  it("a non-deterministic failure is retried once", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    let n = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        n += 1;
        return n === 1 ? new Error("renderer busy") : snapshotReply(p);
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(n, 2, "after the first failure it should retry once and succeed");
  });
});

describe("the runtime main loop: several actions in one round", () => {
  it("executed front to back in array order", async () => {
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({
        actions: [
          { function: "browserInputText", params: { emsn: 1, text: "a" } },
          { function: "browserInputText", params: { emsn: 2, text: "b" } },
          { function: "browserClick", params: { emsn: 3 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "fill a form", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(
      cdp
        .methodSequence()
        .filter((m) =>
          ["Embiody.browserInputText", "Embiody.browserClick"].includes(m),
        ),
      [
        "Embiody.browserInputText",
        "Embiody.browserInputText",
        "Embiody.browserClick",
      ],
    );
    assert.deepEqual(
      cdp.callsTo("Embiody.browserInputText").map((c) => c.params.text),
      ["a", "b"],
      "the order must not change",
    );
  });

  it("one wait per batch (where batching saves most of its time)", async () => {
    // Four actions waiting individually would be 4x postActionMs; waiting once is the point of batching.
    // Verified indirectly by call counts: a sleep is not observable, but "only one round" is.
    const args = await withPlans([
      makePlan({
        actions: [
          { function: "browserInputText", params: { emsn: 1, text: "a" } },
          { function: "browserInputText", params: { emsn: 2, text: "b" } },
          { function: "browserInputText", params: { emsn: 3, text: "c" } },
          { function: "browserClick", params: { emsn: 4 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "fill a form", maxRounds: 2, ...args }),
    );
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      1,
      "four actions observe once, not four times",
    );
    assert.equal(
      vllm.requests.length,
      2,
      "four actions cost two model round trips (one to produce the batch, one to confirm completion)",
    );
  });

  it("stop at the first failure, dropping the rest and saying why", async () => {
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({
        actions: [
          { function: "browserInputText", params: { emsn: 1, text: "a" } },
          { function: "browserClick", params: { emsn: 2 } },
          { function: "browserClick", params: { emsn: 3 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserClick": () => new Error("emsn 2 no longer exists"),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "fill a form", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      1,
      "the second click must not be sent",
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Action 2 \(browserClick\) failed/);
    assert.match(prompt, /remaining 1 action\(s\) were not executed/);
    assert.match(prompt, /double down on a wrong belief/, "it must say why it did not continue");
  });

  it("stop after a page-changing action (every emsn after it is void)", async () => {
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({
        actions: [
          { function: "browserClick", params: { emsn: 1 } },
          { function: "browserNavigate", params: { url: "https://b.test/" } },
          { function: "browserClick", params: { emsn: 2 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 1);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      1,
      "the click after the navigation must not be sent",
    );
    assert.match(vllm.lastUserPrompt(), /voids every emsn/);
  });

  it("anything past the cap is dropped, and the model is told how many", async () => {
    const many = Array.from({ length: MAX_ACTIONS_PER_ROUND + 3 }, (_, i) => ({
      function: "browserInputText",
      params: { emsn: i + 1, text: `v${i}` },
    }));
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({ actions: many }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(
      cdp.callsTo("Embiody.browserInputText").length,
      MAX_ACTIONS_PER_ROUND,
      "execution stops at the cap",
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, new RegExp(`you gave ${MAX_ACTIONS_PER_ROUND + 3} actions`));
    assert.match(prompt, /last 3 were not executed/);
  });

  it("each action in a batch goes to the tab its params.tabId names, not to the working tab", async () => {
    // Every action that moves the working target (navigate, new tab/window, close) also ends the batch,
    // so a later action in the same batch can only reach another tab by naming it.
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({
        action: { function: "browserWait", params: { durationMs: 1 } },
        // To act on 1002 it has to be captured first — a tab never captured has no snapshotId and the action is refused.
        snapshotTabs: ["1001", "1002"],
      }),
      makePlan({
        actions: [
          { function: "browserSetAudioMuted", params: { tabId: "1002", muted: true } },
          { function: "browserClick", params: { tabId: "1002", emsn: 5 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "https://a.test/" }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.lastCall("Embiody.browserSetAudioMuted").params.tabId,
      "1002",
    );
    assert.equal(cdp.lastCall("Embiody.browserClick").params.tabId, "1002");
  });

  it("every step's result is numbered for the model (it needs to know how far it got)", async () => {
    const args = await withPlans([
      // The first round has no snapshot batch (snapshotId) yet, so a click or input is refused — warm up one round to get numbers.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({
        actions: [
          { function: "browserInputText", params: { emsn: 1, text: "a" } },
          { function: "browserClick", params: { emsn: 2 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /Action 1 \(browserInputText\)/);
    assert.match(prompt, /Action 2 \(browserClick\)/);
  });

  it("a handover appearing mid-batch stops immediately and finishes as a pause", async () => {
    const args = await withPlans([
      makePlan({
        actions: [
          { function: "browserStartHumanControl", params: {} },
          { function: "browserClick", params: { emsn: 1 } },
        ],
      }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      0,
      "actions after a handover are bound to fail and must not be sent",
    );
    assert.equal(plan?.next_step_detail.is_paused, true);
  });
});

describe("the runtime main loop: snapshotId", () => {
  // browserClick and browserInputText require a snapshotId, and the kernel validates it. The pdl's own
  // words: a number from the previous batch does not point at a nonexistent element, it points at
  // **a different** element — so a stale number would click something and report success.
  it("after capturing, a click carries this batch's snapshotId", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({ action: { function: "browserClick", params: { emsn: 1 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { snapshotId: "batch-42" }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.lastCall("Embiody.browserClick").params.snapshotId,
      "batch-42",
    );
  });

  it("each round's id follows that round's snapshot (never clicking with the previous round's)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({ action: { function: "browserClick", params: { emsn: 1 } } }),
      makePlan({ action: { function: "browserClick", params: { emsn: 2 } } }),
      makePlan({ complete: true }),
    ]);
    let n = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        n += 1;
        return snapshotReply(p, { snapshotId: `batch-${n}` });
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 4, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(
      cdp.callsTo("Embiody.browserClick").map((c) => c.params.snapshotId),
      ["batch-1", "batch-2"],
      "the second click must use the second snapshot's id",
    );
  });

  it("the first round cannot click or type: there is no snapshot batch yet", async () => {
    // A hard constraint of the new design, and an intuitive one — with no capture in the first round the model holds no emsn at all.
    const args = await withPlans([
      makePlan({ action: { function: "browserClick", params: { emsn: 1 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      0,
      "a click with no id must not be sent",
    );
    assert.match(vllm.lastUserPrompt(), /missing snapshotId/);
    assert.match(vllm.lastUserPrompt(), /snapshot_tabs/, "it must offer a way out");
  });

  it("acting on a tab not captured this round -> refused, with a note to put it in snapshot_tabs", async () => {
    const args = await withPlans([
      // Only 1001 is captured.
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      // But it wants to click 1002.
      makePlan({ action: { function: "browserClick", params: { tabId: "1002", emsn: 1 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "https://a.test/" }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      0,
      "1002 was not captured this round, so it has no id and must not be sent",
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /tab 1002 was not captured this round/);
    assert.match(prompt, /snapshot_tabs/);
    assert.doesNotMatch(prompt, /browser_take_snapshot and pass/, "the outside agent's wording is rewritten");
  });

  it("when a round captures several tabs, each uses its own id", async () => {
    const args = await withPlans([
      makePlan({
        action: { function: "browserWait", params: { durationMs: 1 } },
        snapshotTabs: ["1001", "1002"],
      }),
      makePlan({
        actions: [
          { function: "browserClick", params: { tabId: "1001", emsn: 1 } },
          { function: "browserClick", params: { tabId: "1002", emsn: 1 } },
        ],
      }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserGetWindowInfo": () => ({
        windows: [
          windowInfo({
            tabs: [
              tabInfo({ tabId: "1001", url: "https://a.test/" }),
              tabInfo({ tabId: "1002", index: 1, url: "https://b.test/" }),
            ],
          }),
        ],
        success: true,
      }),
      // Each tab has an id of its own — the easiest mistake in a batch is giving A's number to B.
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {}, (tabId) => ({ snapshotId: `batch-${tabId}` })),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(
      cdp
        .callsTo("Embiody.browserClick")
        .map((c) => `${c.params.tabId}:${c.params.snapshotId}`),
      ["1001:batch-1001", "1002:batch-1002"],
      "a number means something only within its own batch, and ids must not be mixed",
    );
  });

  it("an empty element tree -> treated as a capture failure (how the kernel 'succeeds' when the machine is busy)", async () => {
    // Measured: with another process compiling the browser and saturating the CPU, the kernel "succeeded"
    // with a children:[] tree, a 5KB annotated image and the page not drawn at all. Letting it through
    // breaks two things at once — the model gets a zero-line list and has nowhere to start, and the
    // executor's number gate lets everything through because allowed.size is 0.
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {
          annotatedContent: JSON.stringify({ children: [], tag: { device_scale: 2 } }),
        }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, "a soft failure must not kill the round");
    assert.match(vllm.lastUserPrompt(), /could not be captured/);
  });

  it("an empty tree caused by about:blank -> no recapture (it would look the same however often)", async () => {
    // The kernel says in the message which kind of empty it is. For the two that genuinely
    // have no content, recapturing is a wasted wait, and what the model is told differs too — this one
    // needs browserNavigate first, not waiting for the page to finish drawing.
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {
          annotatedContent: JSON.stringify({ children: [] }),
          message:
            "This page is about:blank, so there is nothing on it to number. Another snapshot will say the same.",
        }),
    });
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(
      cdp.callsTo("Embiody.browserTakeSnapshot").length,
      1,
      "a deterministic empty must not be recaptured for nothing",
    );
    assert.match(vllm.lastUserPrompt(), /blank page|browserNavigate/);
  });

  it("a snapshot with no snapshotId -> treated as a capture failure (without one no element can be acted on)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      // annotatedContent without a snapshotId breaks the pdl's invariant, so this item counts as a failure.
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { snapshotId: undefined }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.equal(error, undefined, "a soft failure must not kill the round");
    assert.match(vllm.lastUserPrompt(), /could not be captured/);
  });
});

describe("the runtime main loop: the snapshot timeoutMs", () => {
  it("the wait ceiling is sent to the kernel when capturing", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(
      cdp.lastCall("Embiody.browserTakeSnapshot").params.timeoutMs,
      7000,
      "7000 by default, matching the kernel's default (split internally into 5s waiting for load plus a 2s capture reserve)",
    );
  });

  it("at the deadline an image still comes back, but the kernel's note must reach the model", async () => {
    // Unlike browserNavigate's timeoutMs: at the deadline this command may still hand back a usable
    // snapshot, and that sentence has to reach the model — the image it sees may be half-built.
    const args = await withPlans([
      makePlan({ action: { function: "browserNavigate", params: { url: "https://a.test/" } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { message: "the page was still loading" }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.match(vllm.lastUserPrompt(), /still loading/);
  });
});

describe("the runtime main loop: recapturing while the page is still loading", () => {
  // Measured on Ctrip: after navigating, the first frame had not finished loading at the 5-second deadline
  // and the snapshot came back with a loadingMessage holding a half-built page (controls not mounted yet).
  // The model could not find its target in that image, settled for a neighbouring number, and by round
  // three ran into "covered by another element" — a wasted round. One recapture costs about 200ms.
  it("a snapshot with a loadingMessage -> that tab is captured again and the new one is used", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({ complete: true }),
    ]);
    let shot = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        shot += 1;
        return shot === 1
          ? snapshotReply(p, { message: "The page had not finished loading after 5000 ms" })
          : snapshotReply(p);
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 2, "it should recapture once");
    // The recaptured one is used: it does not carry the "still loading" sentence.
    assert.doesNotMatch(vllm.lastUserPrompt(), /had not finished loading/);
  });

  it("the recaptured one is still loading -> use it anyway rather than wrestling a slow site", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { message: "The page had not finished loading after 5000 ms" }),
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 2, "only one recapture");
    assert.match(vllm.lastUserPrompt(), /had not finished loading/, "that sentence must reach the model");
  });
});

describe("the runtime main loop: the deadlock backstop", () => {
  // The real failure: the model changed emsn every round while typing into a non-input element, claimed
  // the previous step "completed" every round, and spun on the same leaf for 6 rounds until the budget ran
  // out, with the page unchanged throughout. A counter that reads the model's self-reported completion
  // resets every round for such a model and never rises.
  it("the same next step too many rounds in a row -> the runtime forces a pause", async () => {
    // The same path every round, with a different emsn and a claim that the previous step completed (the shape of the real log).
    const stuckPlan = (emsn: number) =>
      makePlan({
        action: { function: "browserClick", params: { emsn } },
        path: "2.2",
        description: "fill in the destination Beijing",
      });
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      stuckPlan(22),
      stuckPlan(23),
      stuckPlan(25),
      stuckPlan(26),
      stuckPlan(27),
      stuckPlan(28),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 12, ...args }),
    );
    assert.ok(error, "a deadlock should terminate rather than burn through maxRounds");
    assert.match(error!.message, /next step has been 2\.2 .* for 4 rounds/);
    assert.match(error!.message, /no progress on the page/);
    // The cap is 3: the same target runs for 3 rounds, and round 4's plan is rewritten into a pause with no
    // action run. Both numbers are pinned — if the boundary moves (stopping a round early, or burning one
    // more) somebody has to see it.
    assert.equal(cdp.callsTo("Embiody.browserClick").length, 3, "number of clicks");
    assert.equal(vllm.requests.length, 5, "number of model calls: 1 warm-up round plus 4 deadlock rounds");
  });

  it("the model reporting 'completed' does not affect the deadlock test (what fooled the original implementation)", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      ...Array.from({ length: 6 }, () =>
        makePlan({
          action: { function: "browserClick", params: { emsn: 1 } },
          path: "2.2",
          currentStatus: "completed",
        }),
      ),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 12, ...args }),
    );
    assert.ok(error);
    assert.match(error!.message, /next step has been 2\.2 .* for \d+ rounds/);
  });

  // The false positive on Ctrip's date widget: "open the calendar -> change month -> pick a day -> close
  // the panel" is four rounds on the same path, but the page moves every round. A path-only rule would
  // call that a deadlock and interrupt it.
  it("the same next step with the page changing every round -> not a deadlock", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } } }),
      ...Array.from({ length: 6 }, (_, i) =>
        makePlan({
          action: { function: "browserClick", params: { emsn: i + 1 } },
          path: "2.3",
          description: "pick the departure date",
        }),
      ),
      makePlan({ complete: true }),
    ]);
    let shot = 0;
    const cdp = new FakeCdp({
      ...happyRoutes(),
      // A different annotatedContent on every capture: the page really is changing.
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {
          annotatedContent: JSON.stringify({
            round: shot++,
            children: Array.from({ length: 30 }, (_, k) => ({
              node_name: "P",
              emsn: String(k + 1),
            })),
          }),
        }),
    });
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 12, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
    // Not merely "it was not interrupted": the count never rose at all, and what the model is told has to say so.
    assert.match(vllm.lastUserPrompt(), /appeared 1 round/);
    assert.match(vllm.lastUserPrompt(), /different from the last round/);
  });

  it("a next step that is making progress is not misjudged", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } }, path: "1.1" }),
      makePlan({ action: { function: "browserClick", params: { emsn: 1 } }, path: "1.2" }),
      makePlan({ action: { function: "browserClick", params: { emsn: 2 } }, path: "1.3" }),
      makePlan({ action: { function: "browserClick", params: { emsn: 3 } }, path: "1.4" }),
      makePlan({ action: { function: "browserClick", params: { emsn: 4 } }, path: "1.5" }),
      makePlan({ action: { function: "browserClick", params: { emsn: 5 } }, path: "1.6" }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 10, ...args }),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.all_task_is_complete, true);
  });

  it("the prompt reports the next step's repeat count, and not the runtime's backstop threshold", async () => {
    const args = await withPlans([
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } }, path: "2.2" }),
      makePlan({ action: { function: "browserWait", params: { durationMs: 1 } }, path: "2.2" }),
      makePlan({ complete: true }),
    ]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 4, ...args }),
    );
    const prompt = vllm.lastUserPrompt();
    assert.match(prompt, /same next step has now appeared \d+ round/);
    // The runtime's backstop threshold is not reported: reporting it makes the model enforce the backstop
    // itself — measurably, on the very round it had just moved to the next node, it saw "forced pause at 4
    // rounds" and paused itself, while the runtime's own repeat count was 1.
    assert.doesNotMatch(prompt, /forces a pause/);
  });
});

describe("the runtime main loop: budgets, empty plans and stopping", () => {
  const navigate = { function: "browserNavigate", params: { url: "https://a.test/" } };

  it("maxRounds is the number of rounds that act: exactly that many run, then it terminates", async () => {
    const args = await withPlans([makePlan({ action: navigate })]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 2, ...args }),
    );
    assert.ok(error);
    assert.match(error!.message, /maximum of 2 rounds/);
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 2);
    assert.equal(vllm.requests.length, 3, "the planning-only round plus one decision per round");
  });

  it("past totalTimeoutMs no further round starts", async () => {
    const args = await withPlans([makePlan({ action: navigate })]);
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserShow": async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { success: true };
      },
    });
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, totalTimeoutMs: 10, ...args }),
    );
    assert.ok(error);
    assert.match(error!.message, /overall timeout \(10ms\)/);
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 0);
  });

  it("a plan with no action and no pause gets one more look; a second such plan terminates", async () => {
    const args = await withPlans([makePlan({ action: null })]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, ...args }),
    );
    assert.ok(error);
    assert.match(error!.message, /no action_calls/);
    assert.equal(vllm.requests.length, 2);
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 1, "the extra look captures once");
  });

  it("a stop requested mid-round lets that round finish, then ends as a paused plan and closes what the stop asked", async () => {
    const args = await withPlans([makePlan({ action: navigate })]);
    const token = { aborted: false, closeTab: false, closeBrowserWindow: false };
    const cdp = new FakeCdp({
      ...happyRoutes(),
      "Embiody.browserNavigate": () => {
        Object.assign(token, { aborted: true, closeTab: true });
        return navReply();
      },
    });
    const { plan, error, events } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 5, ...args }, token),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.next_step_detail.is_paused, true);
    assert.equal(plan?.all_task_is_complete, false);
    assert.match(plan!.next_step_detail.description, /Stopped manually/);
    assert.ok(hasMessage(events, /stopped manually via browser_stop_task/i), messages(events).join("\n"));
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 1, "nothing runs after the stop");
    assert.equal(vllm.requests.length, 2, "the round in progress still observes and decides");
    assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 1);
    assert.equal(cdp.callsTo("Embiody.browserCloseWindow").length, 0);
  });

  it("a stop already set before the run acts on nothing, and the completion cleanup switches do not apply", async () => {
    const args = await withPlans([makePlan({ action: navigate })]);
    const token = { aborted: true, closeTab: false, closeBrowserWindow: false };
    const cdp = new FakeCdp(happyRoutes());
    const { plan, error } = await drain(
      new BrowserRunTaskRuntime(
        cdp.asCdp(),
        { task: "a test", maxRounds: 5, closeTabWhenDone: true, ...args },
        token,
      ),
    );
    assert.equal(error, undefined, error?.message);
    assert.equal(plan?.next_step_detail.is_paused, true);
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 0);
    assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 0);
  });

  it("a model reply that is not a plan terminates with an error instead of acting on it", async () => {
    const args = await withPlans([{ hello: "not a plan" }]);
    const cdp = new FakeCdp(happyRoutes());
    const { error } = await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 3, ...args }),
    );
    assert.ok(error);
    assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 0);
  });
});

describe("the runtime main loop: finishing", () => {
  it("after completion, close the tab and window per the switches", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), {
        task: "a test",
        maxRounds: 1,
        closeTabWhenDone: true,
        closeBrowserWindowWhenDone: true,
        ...args,
      }),
    );
    assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 1);
    assert.equal(cdp.callsTo("Embiody.browserCloseWindow").length, 1);
  });

  it("nothing is closed by default (the scene is left for a person to look at)", async () => {
    const args = await withPlans([makePlan({ complete: true })]);
    const cdp = new FakeCdp(happyRoutes());
    await drain(
      new BrowserRunTaskRuntime(cdp.asCdp(), { task: "a test", maxRounds: 1, ...args }),
    );
    assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 0);
    assert.equal(cdp.callsTo("Embiody.browserCloseWindow").length, 0);
  });
});
