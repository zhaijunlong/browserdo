import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserRuntimeExecutor } from "../../src/runtime_executor.js";
import {
  RuntimeActionNameSchema,
  type RuntimeActionName,
  type WindowInfo,
} from "../../src/runtime_types.js";
import { FakeCdp } from "../helpers/fake-cdp.js";
import { happyRoutes, navReply, tabInfo, TARGET, windowInfo } from "../helpers/fixtures.js";

/**
 * This round's snapshot ids per tab. Element actions must carry the id of the target tab's
 * batch, so the tests have to provide one too — otherwise everything measured is just the
 * "missing snapshotId" branch.
 */
const SNAPSHOT_IDS = new Map([
  ["1001", "snap-1001"],
  ["1002", "snap-1002"],
]);

function run(
  action: RuntimeActionName,
  params: Record<string, unknown> = {},
  routes: Record<string, unknown> = {},
  layout?: Parameters<BrowserRuntimeExecutor["execute"]>[2],
) {
  const cdp = new FakeCdp({ ...happyRoutes(), ...routes });
  const executor = new BrowserRuntimeExecutor(cdp.asCdp());
  return {
    cdp,
    outcome: executor.execute(
      { function: action, params },
      TARGET,
      layout,
      SNAPSHOT_IDS,
    ),
  };
}

describe("runtime_executor: mapping actions to commands", () => {
  const mapping: Array<[RuntimeActionName, string, Record<string, unknown>]> = [
    ["browserNavigate", "Embiody.browserNavigate", { url: "https://a.test/" }],
    ["browserGoBack", "Embiody.browserGoBack", {}],
    ["browserGoForward", "Embiody.browserGoForward", {}],
    ["browserReload", "Embiody.browserReload", {}],
    ["browserStopLoading", "Embiody.browserStopLoading", {}],
    ["browserClick", "Embiody.browserClick", { emsn: 7 }],
    ["browserInputText", "Embiody.browserInputText", { text: "hi" }],
    ["browserPressKey", "Embiody.browserPressKey", { keys: ["Escape"] }],
    ["browserSelectEditableText", "Embiody.browserSelectEditableText", { emsn: 7, select: "hi" }],
    ["browserScroll", "Embiody.browserScroll", { deltaY: 400 }],
    ["browserMove", "Embiody.browserMove", { emsn: 7 }],
    ["browserDrag", "Embiody.browserDrag", { emsn: 7, toEmsn: 9 }],
    ["browserClosePopupBubble", "Embiody.browserClosePopupBubble", {}],
    ["browserSetAudioMuted", "Embiody.browserSetAudioMuted", { muted: true }],
    ["browserCloseTab", "Embiody.browserCloseTab", {}],
    ["browserNewWindow", "Embiody.browserNewWindow", {}],
    ["browserAddNewTab", "Embiody.browserNewTab", {}],
    ["browserCloseWindow", "Embiody.browserCloseWindow", {}],
    ["browserStartHumanControl", "Embiody.browserStartHumanControl", {}],
    ["browserStopHumanControl", "Embiody.browserStopHumanControl", {}],
  ];

  for (const [action, method, params] of mapping) {
    it(`${action} → ${method}`, async () => {
      const { cdp, outcome } = run(action, params);
      await outcome;
      assert.deepEqual(cdp.methodSequence(), [method]);
    });
  }

  it("browserWait touches no CDP", async () => {
    const { cdp, outcome } = run("browserWait", { durationMs: 100 });
    await outcome;
    assert.deepEqual(cdp.calls, []);
  });

  it("queryHistoryPage reaching the executor is a bug — the main loop should intercept it first", async () => {
    const { outcome } = run("queryHistoryPage", { keyword: "x" });
    await assert.rejects(() => outcome, /answered by the runtime/);
  });

  it("every action in the action table is covered above (a new action needs a new test)", () => {
    const covered = new Set<string>([
      ...mapping.map(([a]) => a),
      "browserWait",
      "queryHistoryPage",
    ]);
    const uncovered = RuntimeActionNameSchema.options.filter(
      (a) => !covered.has(a),
    );
    assert.deepEqual(uncovered, [], `added to the action table but untested: ${uncovered.join(", ")}`);
  });
});

describe("runtime_executor: with no layout to check against, ids come from the working target", () => {
  // A tabId the model names is trusted only once this round's layout confirms it (see the next
  // group); without a layout every action's ids come from target, and windowId always does.
  const idBearing: Array<[RuntimeActionName, string, Record<string, unknown>]> = [
    ["browserNavigate", "Embiody.browserNavigate", { url: "https://a.test/" }],
    ["browserClick", "Embiody.browserClick", { emsn: 1 }],
    ["browserInputText", "Embiody.browserInputText", { text: "x" }],
    ["browserScroll", "Embiody.browserScroll", { deltaY: 1 }],
    ["browserGoBack", "Embiody.browserGoBack", {}],
    ["browserReload", "Embiody.browserReload", {}],
    ["browserStopLoading", "Embiody.browserStopLoading", {}],
    ["browserCloseTab", "Embiody.browserCloseTab", {}],
    ["browserClosePopupBubble", "Embiody.browserClosePopupBubble", {}],
    ["browserSetAudioMuted", "Embiody.browserSetAudioMuted", { muted: true }],
    ["browserStartHumanControl", "Embiody.browserStartHumanControl", {}],
  ];

  for (const [action, method, params] of idBearing) {
    it(`${action} ignores a windowId/tabId the model filled in itself`, async () => {
      const { cdp, outcome } = run(action, {
        ...params,
        windowId: "invented by the model",
        tabId: "invented by the model",
      });
      await outcome;
      const call = cdp.lastCall(method);
      assert.equal(call.params.windowId, TARGET.windowId);
      assert.equal(call.params.tabId, TARGET.tabId);
    });
  }

  it("browserCloseWindow closes only the working target's window and does not accept another one from the model", async () => {
    const { cdp, outcome } = run("browserCloseWindow", { windowId: "somebody else's window" });
    await outcome;
    assert.equal(cdp.lastCall("Embiody.browserCloseWindow").params.windowId, TARGET.windowId);
  });

  it("browserAddNewTab opens the tab in the working target's window", async () => {
    const { cdp, outcome } = run("browserAddNewTab", {});
    await outcome;
    assert.equal(cdp.lastCall("Embiody.browserNewTab").params.windowId, TARGET.windowId);
  });
});

describe("runtime_executor: a tabId the model names is checked against this round's layout", () => {
  const LAYOUT = [
    windowInfo({ windowId: "900", tabs: [tabInfo({ tabId: "1001" })] }),
    windowInfo({ windowId: "901", tabs: [tabInfo({ tabId: "2002" })] }),
  ] as unknown as WindowInfo[];

  it("a tab in the layout is used, and windowId follows it even if the model wrote another", async () => {
    const { cdp, outcome } = run(
      "browserReload",
      { tabId: "2002", windowId: "900" },
      {},
      LAYOUT,
    );
    await outcome;
    const sent = cdp.lastCall("Embiody.browserReload").params;
    assert.equal(sent.tabId, "2002");
    assert.equal(sent.windowId, "901");
  });

  it("a number written for a tabId is accepted like the string", async () => {
    const { cdp, outcome } = run("browserReload", { tabId: 2002 }, {}, LAYOUT);
    await outcome;
    assert.equal(cdp.lastCall("Embiody.browserReload").params.tabId, "2002");
  });

  it("a tab not in the layout is refused before anything is sent, listing the tabs that exist", async () => {
    const { cdp, outcome } = run("browserReload", { tabId: "7777" }, {}, LAYOUT);
    await assert.rejects(() => outcome, /tabId=7777 is not in this round layout.*1001, 2002/);
    assert.equal(cdp.callsTo("Embiody.browserReload").length, 0);
  });

  it("a literal \"null\" tabId counts as not named", async () => {
    const { cdp, outcome } = run("browserReload", { tabId: "null" }, {}, LAYOUT);
    await outcome;
    assert.equal(cdp.lastCall("Embiody.browserReload").params.tabId, TARGET.tabId);
  });
});

describe("runtime_executor: targetUpdate and landedUrl", () => {
  it("after opening a tab, the working target moves to the new tabId", async () => {
    const { outcome } = run("browserAddNewTab", { url: "https://a.test/" });
    const res = await outcome;
    assert.equal(res.targetUpdate?.tabId, "1002");
  });

  it("after creating a window, both windowId and tabId move", async () => {
    const { outcome } = run("browserNewWindow", {});
    const res = await outcome;
    assert.equal(res.targetUpdate?.windowId, "901");
    assert.equal(res.targetUpdate?.tabId, "1002");
  });

  it("after navigating, landedUrl is where the kernel says it landed (a redirect)", async () => {
    const { outcome } = run(
      "browserNavigate",
      { url: "https://short.test/x" },
      { "Embiody.browserNavigate": () => navReply({ url: "https://final.test/y" }) },
    );
    const res = await outcome;
    assert.equal(res.landedUrl, "https://final.test/y");
  });

  it("after going back, landedUrl is the address history took the tab to", async () => {
    const { outcome } = run(
      "browserGoBack",
      {},
      { "Embiody.browserGoBack": () => navReply({ url: "https://prev.test/" }) },
    );
    assert.equal((await outcome).landedUrl, "https://prev.test/");
  });

  it("a non-navigation action has no landedUrl", async () => {
    assert.equal((await run("browserClick", { emsn: 1 }).outcome).landedUrl, undefined);
  });

  it("startHumanControl carries a humanControl flag out (the runtime finishes as a pause on it)", async () => {
    assert.equal(
      (await run("browserStartHumanControl", {}).outcome).humanControl,
      true,
    );
  });
});

describe("runtime_executor: only genuinely usable ids reach the working target", () => {
  // `!== undefined` is not enough of a gate: null becomes "null" and an empty string becomes "",
  // and both would be written in as a valid working target, after which every command reports that
  // the tab cannot be found.
  const junk: Array<[string, unknown]> = [
    ["an empty string", ""],
    ["only whitespace", "   "],
    ['the literal "undefined"', "undefined"],
    ['the literal "null"', "null"],
    ["null", null],
  ];
  for (const [why, tabId] of junk) {
    it(`a returned tabId that is ${why} -> the working target is not updated`, async () => {
      const { outcome } = run(
        "browserAddNewTab",
        {},
        {
          "Embiody.browserNewTab": () => ({
            windowId: "900",
            tabId,
            title: "",
            url: "https://a.test/",
            loadStatus: "titled",
          }),
        },
      );
      // A reply with no usable tabId may also fail the action outright; either way the target stays.
      const res = await outcome.catch(() => undefined);
      assert.equal(
        res?.targetUpdate?.tabId,
        undefined,
        `${why} should not be taken for a tabId`,
      );
    });
  }

  it("an ordinary tabId updates as usual", async () => {
    const res = await run("browserAddNewTab", {}).outcome;
    assert.equal(res.targetUpdate?.tabId, "1002");
  });
});

describe("runtime_executor: editing and keys", () => {
  it("passes a place on; a number written as a string is read, an unknown at is dropped", async () => {
    const a = run("browserInputText", { emsn: 7, text: "", replace: "很", occurrence: "2" });
    await a.outcome;
    const sent = a.cdp.lastCall("Embiody.browserInputText");
    assert.equal(sent.params.replace, "很");
    assert.equal(sent.params.occurrence, 2);

    const b = run("browserInputText", { emsn: 7, text: "x", at: "middle", before: 3 });
    await b.outcome;
    const keys = b.cdp.lastCall("Embiody.browserInputText").wireKeys;
    assert.ok(!keys.includes("at") && !keys.includes("before"), "a place of the wrong kind is dropped, not sent");
  });

  it("keys may come as {key}, as bare names, as one key, or under key", async () => {
    const forms: Array<[Record<string, unknown>, unknown]> = [
      [{ keys: [{ key: "ArrowLeft", repeatCount: "2" }] }, [{ key: "ArrowLeft", repeatCount: 2 }]],
      [{ keys: ["End", "Enter"] }, [{ key: "End" }, { key: "Enter" }]],
      [{ keys: "Escape" }, [{ key: "Escape" }]],
      [{ key: "Tab" }, [{ key: "Tab" }]],
    ];
    for (const [params, expected] of forms) {
      const r = run("browserPressKey", params);
      await r.outcome;
      const keys = r.cdp.lastCall("Embiody.browserPressKey").params.keys as Array<{ key: string; repeatCount?: number }>;
      const sent = keys.map((k) => (k.repeatCount === undefined ? { key: k.key } : k));
      assert.deepEqual(sent, expected, JSON.stringify(params));
    }
  });

  it("no keys at all still go to the kernel, which refuses the empty list", async () => {
    const r = run("browserPressKey", {});
    await r.outcome;
    assert.deepEqual(r.cdp.lastCall("Embiody.browserPressKey").params.keys, []);
  });

  it("browserSelectEditableText passes the way of selecting on, all as a real boolean", async () => {
    const r = run("browserSelectEditableText", { emsn: 7, all: "true" });
    await r.outcome;
    assert.equal(r.cdp.lastCall("Embiody.browserSelectEditableText").params.all, true);
  });

  it("browserSelectEditableText without emsn is refused here, and nothing is sent", async () => {
    const r = run("browserSelectEditableText", { select: "hi" });
    await assert.rejects(() => r.outcome, /needs params\.emsn/);
    assert.equal(r.cdp.callsTo("Embiody.browserSelectEditableText").length, 0);
  });
});

describe("runtime_executor: reading parameters", () => {
  it("both emsn and the old name nodeId are accepted (the model still emits the old one occasionally)", async () => {
    const a = run("browserClick", { nodeId: 12 });
    await a.outcome;
    assert.equal(a.cdp.lastCall("Embiody.browserClick").params.emsn, 12);

    const b = run("browserClick", { emsn: 34 });
    await b.outcome;
    assert.equal(b.cdp.lastCall("Embiody.browserClick").params.emsn, 34);
  });

  it("an emsn that is an empty string or null counts as absent (falling back to coordinates, or refused outright)", async () => {
    for (const emsn of ["", null]) {
      const { outcome } = run("browserClick", { emsn });
      await assert.rejects(() => outcome, /requires either emsn or x,y/, JSON.stringify(emsn));
    }
  });

  it("booleans written as strings are read as booleans — \"false\" must not mute", async () => {
    const r = run("browserSetAudioMuted", { muted: "false" });
    await r.outcome;
    assert.equal(r.cdp.lastCall("Embiody.browserSetAudioMuted").params.muted, false);

    const t = run("browserInputText", { emsn: 7, text: "x", pressEnter: "true", clearText: "0" });
    await t.outcome;
    const sent = t.cdp.lastCall("Embiody.browserInputText").params;
    assert.equal(sent.pressEnter, true);
    assert.equal(sent.clearText, false);
  });

  it("browserScroll takes its pane under the wire name onEmsn too", async () => {
    const r = run("browserScroll", { deltaY: 100, onEmsn: 7 });
    await r.outcome;
    assert.equal(r.cdp.lastCall("Embiody.browserScroll").params.onEmsn, 7);
  });

  it("waitUntil goes through a whitelist: legal values pass, illegal ones are dropped in favour of the kernel default", async () => {
    const good = run("browserNavigate", { url: "https://a.test/", waitUntil: "load" });
    await good.outcome;
    assert.equal(good.cdp.lastCall("Embiody.browserNavigate").params.waitUntil, "load");

    const bad = run("browserNavigate", { url: "https://a.test/", waitUntil: "loaded" });
    await bad.outcome;
    assert.ok(
      !bad.cdp.lastCall("Embiody.browserNavigate").wireKeys.includes("waitUntil"),
      "loaded is the reply-side spelling, not a request-side milestone",
    );
  });

  it("a timeoutMs that is not a number, or not positive, is dropped", async () => {
    for (const bad of ["abc", -1, 0, null]) {
      const { cdp, outcome } = run("browserNavigate", {
        url: "https://a.test/",
        timeoutMs: bad,
      });
      await outcome;
      assert.ok(
        !cdp.lastCall("Embiody.browserNavigate").wireKeys.includes("timeoutMs"),
        `timeoutMs=${String(bad)} should never be sent`,
      );
    }
  });

  it("browserSetAudioMuted only unmutes on an explicit false", async () => {
    const off = run("browserSetAudioMuted", { muted: false });
    await off.outcome;
    assert.equal(off.cdp.lastCall("Embiody.browserSetAudioMuted").params.muted, false);

    // With no muted given, treat it as mute — the common intent behind this action is to quieten the page.
    const on = run("browserSetAudioMuted", {});
    await on.outcome;
    assert.equal(on.cdp.lastCall("Embiody.browserSetAudioMuted").params.muted, true);
  });
});

describe("runtime_executor: failures surface as thrown errors (recorded by the runtime as this round's failure)", () => {
  it("an action with ok=false throws an error carrying the original text", async () => {
    const { outcome } = run(
      "browserNavigate",
      { url: "https://a.test/" },
      { "Embiody.browserNavigate": () => navReply({ loadStatus: "failed" }) },
    );
    await assert.rejects(() => outcome, /loadStatus=failed/);
  });

  it("a kernel throw is rethrown too", async () => {
    const { outcome } = run(
      "browserClick",
      { emsn: 1 },
      { "Embiody.browserClick": () => new Error("emsn 1 no longer exists") },
    );
    await assert.rejects(() => outcome, /no longer exists/);
  });
});

describe("runtime-executor: blocking an emsn that was never shown", () => {
  // Hit once for real: the model gave emsn=41 (the renderer had missed the numbers on text_infos
  // that round, so 41 never reached the text), the kernel clicked it anyway and reported "clicked",
  // and 16 September silently became 1 September.
  //
  // The kernel validates emsn too, but what it validates is "the number belongs to this batch" —
  // its own numbering table is larger than annotatedContent's, so a number never shown is still
  // recognised and clicked. This gate covers exactly "was it ever shown".
  const SETS = new Map<string, ReadonlyMap<string, string>>([
    ["1001", new Map([["7", '7 BUTTON "alpha"'], ["12", '12 A "beta"'], ["112", '112 SPAN "gamma"']])],
  ]);

  // Deliberately no default for sets: passing undefined explicitly triggers the default parameter,
  // and "do not block when there is no list" would quietly become "there is a list", so the test
  // would not measure what it claims to.
  const runWithSets = (
    action: RuntimeActionName,
    params: Record<string, unknown>,
    sets: Map<string, ReadonlyMap<string, string>> | undefined,
  ) => {
    const cdp = new FakeCdp(happyRoutes());
    const executor = new BrowserRuntimeExecutor(cdp.asCdp());
    return {
      cdp,
      outcome: executor.execute(
        { function: action, params },
        TARGET,
        undefined,
        SNAPSHOT_IDS,
        sets,
      ),
    };
  };

  it("a number in this round's list -> runs as usual", async () => {
    const { cdp, outcome } = runWithSets("browserClick", { emsn: 12 }, SETS);
    await outcome;
    assert.equal(cdp.lastCall("Embiody.browserClick").params.emsn, 12);
  });

  it("a number falling in a hole gets the nearest usable numbers on both sides, with their text", async () => {
    // Saying only "pick another" does not rescue it: in the observed run the model wanted "Air China"
    // (105) and gave 104, and 104 was a hole. It gave the same 104 twice and then gave up, with the
    // right answer next door. That round held 223 numbers, so the whole list cannot be sent back —
    // only the two nearest on each side.
    const many = new Map<string, ReadonlyMap<string, string>>([
      [
        "1001",
        new Map(
          [100, 102, 103, 105, 106, 108, 200].map((n) => [
            String(n),
            `${n} SPAN "item ${n}"`,
          ]),
        ),
      ],
    ]);
    const { outcome } = runWithSets("browserClick", { emsn: 104 }, many);
    const err = await outcome.then(
      () => undefined,
      (e: unknown) => String((e as Error).message),
    );
    assert.ok(err, "it should be refused");
    assert.match(err!, /nearest usable numbers are/);
    assert.match(err!, /102 SPAN "item 102"/, "the nearest below must be there");
    assert.match(err!, /103 SPAN "item 103"/, "the second nearest below must be there");
    assert.match(err!, /105 SPAN "item 105"/, "the nearest above must be there");
    assert.match(err!, /106 SPAN "item 106"/, "the second nearest above must be there");
    assert.doesNotMatch(err!, /100 SPAN|200 SPAN/, "nothing further out — this is not dumping the list back");
  });

  // Measured on Ctrip: the model typed into `56 I`, the swap icon between origin and destination.
  // The kernel implements typing as "click to take focus, then type", so the input failed, the icon
  // got clicked, origin and destination swapped, and everything after that searched the reverse
  // route — while the action result said only "input failed".
  it("typing into an element that can never carry text -> refused on the spot, with not a byte sent to the kernel", async () => {
    const sets = new Map<string, ReadonlyMap<string, string>>([
      ["1001", new Map([["56", "56 I"], ["58", '58 INPUT:text [pick a date] ="2026-09-23"']])],
    ]);
    const { cdp, outcome } = runWithSets(
      "browserInputText",
      { emsn: 56, text: "Shenzhen" },
      sets,
    );
    const err = await outcome.then(
      () => undefined,
      (e: unknown) => String((e as Error).message),
    );
    assert.match(err!, /emsn=56 is an? I, which can never hold text/);
    assert.match(err!, /the element was not touched/);
    assert.equal(
      cdp.callsTo("Embiody.browserInputText").length,
      0,
      "that click is itself the harm and must be stopped before it is sent",
    );
  });

  it("clicking the same element with browserClick is legal — what is blocked is typing, not clicking", async () => {
    const sets = new Map<string, ReadonlyMap<string, string>>([
      ["1001", new Map([["56", "56 I"]])],
    ]);
    const { cdp, outcome } = runWithSets("browserClick", { emsn: 56 }, sets);
    await outcome;
    assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
  });

  it("INPUT / TEXTAREA and lines with an unrecognisable tag pass as usual (contenteditable is unrecognisable)", async () => {
    const sets = new Map<string, ReadonlyMap<string, string>>([
      [
        "1001",
        new Map([
          ["58", '58 INPUT:text [pick a date] ="2026-09-23"'],
          ["59", "59 TEXTAREA"],
          ["60", "60"],
        ]),
      ],
    ]);
    for (const emsn of [58, 59, 60]) {
      const { cdp, outcome } = runWithSets(
        "browserInputText",
        { emsn, text: "x" },
        sets,
      );
      await outcome;
      assert.equal(
        cdp.callsTo("Embiody.browserInputText").length,
        1,
        `emsn=${emsn} was blocked by mistake`,
      );
    }
  });

  it("a number not in the list -> refused on the spot, with nothing sent to the kernel", async () => {
    const { cdp, outcome } = runWithSets("browserClick", { emsn: 41 }, SETS);
    await assert.rejects(() => outcome, /emsn=41 is not in this round element list/);
    assert.equal(
      cdp.callsTo("Embiody.browserClick").length,
      0,
      "it must not be sent — a silent misclick is far worse than failing on the spot",
    );
  });

  it("a drag's far end passes the same gate — an invented toEmsn is no safer than an invented emsn", async () => {
    const { cdp, outcome } = runWithSets(
      "browserDrag",
      // The near end is a number that was shown, so only the far end can be what stops this.
      { emsn: 7, toEmsn: 41 },
      SETS,
    );
    await assert.rejects(() => outcome, /emsn=41 is not in this round element list/);
    assert.equal(cdp.callsTo("Embiody.browserDrag").length, 0);
  });

  it("the refusal offers a way out: go back to annotatedContent and choose again", async () => {
    const { outcome } = runWithSets("browserInputText", { emsn: 999, text: "x" }, SETS);
    const err = (await outcome.catch((e: Error) => e)) as Error;
    assert.match(err.message, /annotatedContent/);
    assert.match(err.message, /annotated image/, "it should point out it may have been misread off the image");
    assert.match(err.message, /3 usable numbers/, "it should say how large the list is");
  });

  it("actions with no emsn are unaffected (scrolling, navigating)", async () => {
    const { cdp, outcome } = runWithSets("browserScroll", { deltaY: 400 }, SETS);
    await outcome;
    assert.equal(cdp.callsTo("Embiody.browserScroll").length, 1);
  });

  it("no list means no blocking (the MCP path has no notion of this round's snapshot)", async () => {
    const { cdp, outcome } = runWithSets("browserClick", { emsn: 41 }, undefined);
    await outcome;
    assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
  });

  // readEmsn sends params.nodeId as the emsn, but the gate reads only emsn / toEmsn / onEmsn, so
  // the old name slips past both the "was it shown" check and the never-typable check. Skipped
  // until fixed; today the click below is sent.
  it("the old name nodeId passes the same gate as emsn", async () => {
    const { cdp, outcome } = runWithSets("browserClick", { nodeId: 41 }, SETS);
    await assert.rejects(() => outcome, /emsn=41 is not in this round element list/);
    assert.equal(cdp.callsTo("Embiody.browserClick").length, 0);
  });

  it("an empty list means no blocking (with no full set of numbers we must not seize up)", async () => {
    const { cdp, outcome } = runWithSets(
      "browserClick",
      { emsn: 41 },
      new Map([["1001", new Map<string, string>()]]),
    );
    await outcome;
    assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
  });
});

describe("runtime-executor: the emsn check applies only to actions that really take an emsn", () => {
  // Only the actions in EMSN_WIRE_PARAMS take a number. The model plausibly attaches an emsn to
  // other actions as well (it writes emsn every round), and that must not have this gate refuse a
  // legitimate operation over a parameter the kernel never even looks at.
  const SETS = new Map<string, ReadonlyMap<string, string>>([
    ["1001", new Map([["7", '7 BUTTON "alpha"']])],
  ]);

  const runWith = (action: RuntimeActionName, params: Record<string, unknown>) => {
    const cdp = new FakeCdp(happyRoutes());
    const executor = new BrowserRuntimeExecutor(cdp.asCdp());
    return {
      cdp,
      outcome: executor.execute(
        { function: action, params },
        TARGET,
        undefined,
        SNAPSHOT_IDS,
        SETS,
      ),
    };
  };

  // Since late September 2026 an emsn on browserScroll names the pane to scroll (it goes out as onEmsn), so
  // an unshown number would put the pointer on an element we never showed. -1 is the blank area,
  // never in the list, and the kernel checks it against the snapshot itself.
  it("browserScroll's pane number is gated like a click's; -1 (the page) passes", async () => {
    const bad = runWith("browserScroll", { deltaY: 400, emsn: 999 });
    await assert.rejects(bad.outcome, /emsn=999 is not in this round element list/);
    assert.equal(bad.cdp.callsTo("Embiody.browserScroll").length, 0);

    const ok = runWith("browserScroll", { deltaY: 400, emsn: 7 });
    await ok.outcome;
    assert.equal(ok.cdp.lastCall("Embiody.browserScroll").params.onEmsn, 7);

    const page = runWith("browserScroll", { deltaY: 400, emsn: -1 });
    await page.outcome;
    assert.equal(page.cdp.lastCall("Embiody.browserScroll").params.onEmsn, -1);
  });

  it("browserClosePopupBubble takes no emsn, so a stray one is not gated", async () => {
    const { cdp, outcome } = runWith("browserClosePopupBubble", {
      action: "dismiss",
      emsn: 999,
    });
    await outcome;
    assert.equal(cdp.callsTo("Embiody.browserClosePopupBubble").length, 1);
  });

  it("but browserClick / browserInputText are still checked", async () => {
    for (const fn of ["browserClick", "browserInputText"] as const) {
      const { outcome } = runWith(fn, { emsn: 999, text: "x" });
      await assert.rejects(() => outcome, /emsn=999 is not in this round element list/);
    }
  });
});
