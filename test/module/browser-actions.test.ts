import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
// This line must come before every src/ import: it redirects snapshot output to a temp directory, so tests do not dirty the working directory.
import "../helpers/tmp-snapshot-dir.js";
import * as A from "../../src/browser-actions.js";
import { FakeCdp } from "../helpers/fake-cdp.js";
import {
  happyRoutes,
  navReply,
  snapshotReply,
  TARGET,
  tabInfo,
  windowInfo,
} from "../helpers/fixtures.js";

const cdpWith = (over: Record<string, unknown> = {}) =>
  new FakeCdp({ ...happyRoutes(), ...over });

/** The id of this batch of numbers, which every command naming an emsn or a point carries. */
const SNAP = { snapshotId: "snap-1" };

describe("browser-actions: does this annotatedContent count as empty", () => {
  // An empty list breaks two gates at once: the model gets 0 lines and has nowhere to start, and the
  // executor's number gate checks allowed.size and lets everything through when the list is empty. So
  // "counts as empty" has to match "the model can see nothing".
  const el = '{"node_name":"P","emsn":"1","text_runs":[{"text":"alpha"}]}';
  const cases: Array<[string, string, boolean]> = [
    ["holds an element", `{"children":[${el}]}`, false],
    ["children is an empty array — how the kernel 'succeeds' under heavy load", '{"children":[]}', true],
    ["only a viewport, no children", '{"viewport":{"width":1366,"height":768}}', true],
    // The next three are **valid trees** and are what this rule really has to cover: all have
    // children.length above 0, so by "does it have children" they are non-empty, yet they render to nothing.
    ["only empty containers", '{"children":[{"children":[]}]}', true],
    ["only a region, with nothing inside it", '{"children":[{"bbox":[0,0,100,50],"children":[]}]}', true],
    ["an element, but with no text and no number", '{"children":[{"node_name":"DIV","bbox":[0,0,10,10]}]}', true],
    // Malformed input is covered in passing. The kernel never sends these shapes; these two only make
    // sure the rule does not become more permissive on them.
    ["children is a string", '{"children":"oops"}', true],
    ["children holds only null", '{"children":[null]}', true],
    // When parsing fails the renderer hands the content to the model unchanged (verbose beats blank), and that content is still useful.
    ["not JSON at all", "not json at all", false],
  ];
  for (const [name, raw, want] of cases) {
    it(`${name} -> ${want ? "empty" : "not empty"}`, () => {
      assert.equal(A.isEmptyAnnotatedTree(raw), want);
    });
  }
});

describe("browser-actions: a navigation reply can only be read through loadStatus", () => {
  // This group maps directly onto the breaking change in the September 2026 protocol revision: the reply has no success, so the old
  // `if (result?.success === false)` was always false and a failed navigation reported success.
  const cases: Array<[string, boolean, string]> = [
    ["committed", true, "a same-document navigation (an anchor, history.push) only reaches committed, and that is a normal arrival"],
    ["titled", true, "the default milestone"],
    ["firstPaint", true, "it was painted"],
    ["loaded", true, "fully loaded"],
    ["failed", false, "a network error, or a response that does not navigate (a download, a 204)"],
    ["timeout", false, "nothing committed before the deadline; where it landed is unknown"],
  ];

  for (const [loadStatus, expectOk, why] of cases) {
    it(`loadStatus=${loadStatus} → ok=${expectOk}（${why}）`, async () => {
      const cdp = cdpWith({
        "Embiody.browserNavigate": () => navReply({ loadStatus }),
      });
      const r = await A.browserNavigate(cdp.asCdp(), {
        url: "https://a.test/",
        ...TARGET,
      });
      assert.equal(r.ok, expectOk, r.text);
      assert.equal(r.data?.loadStatus, loadStatus);
      assert.match(r.text, new RegExp(loadStatus));
    });
  }

  it("a reply with no loadStatus counts as uninterpretable, never as success by default", async () => {
    const cdp = cdpWith({
      "Embiody.browserNavigate": () => ({ windowId: "900", tabId: "1001" }),
    });
    const r = await A.browserNavigate(cdp.asCdp(), {
      url: "https://a.test/",
      ...TARGET,
    });
    assert.equal(r.ok, false);
    assert.match(r.text, /carries no loadStatus/);
  });

  it("even a reply carrying success:false does not affect judging by loadStatus (success is no longer a field of these commands)", async () => {
    const cdp = cdpWith({
      "Embiody.browserNavigate": () =>
        ({ ...navReply({ loadStatus: "loaded" }), success: false }) as unknown,
    });
    const r = await A.browserNavigate(cdp.asCdp(), {
      url: "https://a.test/",
      ...TARGET,
    });
    assert.equal(r.ok, true);
  });

  it("the landing url comes from the reply, not the request (a redirect)", async () => {
    const cdp = cdpWith({
      "Embiody.browserNavigate": () =>
        navReply({ url: "https://final.test/landed" }),
    });
    const r = await A.browserNavigate(cdp.asCdp(), {
      url: "https://short.test/x",
      ...TARGET,
    });
    assert.equal(r.data?.url, "https://final.test/landed");
    assert.match(r.text, /final\.test\/landed/);
    assert.doesNotMatch(r.text, /landed at https:\/\/short\.test/);
  });
});

describe("browser-actions: an unrecognised loadStatus must fail safe", () => {
  // The same shape as the original success bug: with "exclude the known failure states", a new failure
  // value added by the kernel later is silently treated as success. A whitelist keeps the direction safe.
  for (const unknown of ["aborted", "blockedByClient", "somethingNew"]) {
    it(`loadStatus=${unknown} counts as uninterpretable, not success by default`, async () => {
      const cdp = cdpWith({
        "Embiody.browserNavigate": () => navReply({ loadStatus: unknown }),
      });
      const r = await A.browserNavigate(cdp.asCdp(), {
        url: "https://a.test/",
        ...TARGET,
      });
      assert.equal(r.ok, false, "an unrecognised value must not count as arrival");
      assert.match(r.text, /does not recognise/);
      assert.match(r.text, new RegExp(unknown));
      assert.match(r.text, /do not assume success/);
    });
  }

  it("all four arrival milestones are in the whitelist (a missing one makes a normal navigation count as failed)", async () => {
    for (const good of ["committed", "titled", "firstPaint", "loaded"]) {
      const cdp = cdpWith({
        "Embiody.browserNavigate": () => navReply({ loadStatus: good }),
      });
      const r = await A.browserNavigate(cdp.asCdp(), {
        url: "https://a.test/",
        ...TARGET,
      });
      assert.equal(r.ok, true, `${good} should count as arrival: ${r.text}`);
    }
  });
});

describe("browser-actions: opening a tab and loading a page are two things", () => {
  // Once the kernel returns a tabId the tab exists. Reporting failure here would throw the tabId away
  // too, leaking a tab in the window that the model neither knows about nor can navigate, and a retry
  // would leak another.
  for (const bad of ["failed", "timeout"]) {
    it(`loadStatus=${bad} but a tabId came back -> still a success, and the tabId is handed over`, async () => {
      const cdp = cdpWith({
        "Embiody.browserNewTab": () =>
          navReply({ tabId: "2002", loadStatus: bad, url: "" }),
      });
      const r = await A.browserAddNewTab(cdp.asCdp(), {
        windowId: "900",
        url: "https://dead.test/",
      });
      assert.equal(r.ok, true, "the tab was created, so this cannot be a failure: " + r.text);
      assert.equal(r.data?.tabId, "2002", "the tabId must not be lost");
      assert.match(r.text, /The tab itself was created/);
      assert.match(r.text, /browserNavigate/, "the model must be told what to do next");
      assert.match(r.text, new RegExp(bad), "the fact that loading failed must be said too");
    });
  }

  it("only when not even a tabId came back is it a real failure", async () => {
    const cdp = cdpWith({
      "Embiody.browserNewTab": () =>
        ({ windowId: "900", loadStatus: "failed" }) as unknown,
    });
    const r = await A.browserAddNewTab(cdp.asCdp(), { windowId: "900" });
    assert.equal(r.ok, false);
  });
});

describe("browser-actions: validating the required windowId/tabId", () => {
  // Since the September 2026 protocol revision both parameters are required. Sending the call anyway when one is missing lets
  // JSON drop the undefined and buys an InvalidParams; refusing at this layer is what says which action
  // is missing what.
  const needsBoth: Array<[string, () => Promise<A.ActionResult>]> = [
    ["browserNavigate", () => A.browserNavigate(cdpWith().asCdp(), { url: "https://a.test/" })],
    ["browserGoBack", () => A.browserGoBack(cdpWith().asCdp(), {})],
    ["browserGoForward", () => A.browserGoForward(cdpWith().asCdp(), {})],
    ["browserReload", () => A.browserReload(cdpWith().asCdp(), {})],
    ["browserStopLoading", () => A.browserStopLoading(cdpWith().asCdp(), {})],
    ["browserSetAudioMuted", () => A.browserSetAudioMuted(cdpWith().asCdp(), { muted: true })],
    ["browserCloseTab", () => A.browserCloseTab(cdpWith().asCdp(), {})],
    ["browserClosePopupBubble", () => A.browserClosePopupBubble(cdpWith().asCdp(), {})],
    ["browserClick", () => A.browserClick(cdpWith().asCdp(), { emsn: 1, ...SNAP })],
    ["browserInputText", () => A.browserInputText(cdpWith().asCdp(), { text: "x", ...SNAP })],
    ["browserPressKey", () => A.browserPressKey(cdpWith().asCdp(), { keys: [{ key: "Escape" }], ...SNAP })],
    ["browserSelectEditableText", () => A.browserSelectEditableText(cdpWith().asCdp(), { emsn: 1, all: true, ...SNAP })],
    ["browserScroll", () => A.browserScroll(cdpWith().asCdp(), { deltaY: 1 })],
    ["browserMove", () => A.browserMove(cdpWith().asCdp(), { emsn: 1, ...SNAP })],
    ["browserDrag", () => A.browserDrag(cdpWith().asCdp(), { emsn: 1, toEmsn: 2, ...SNAP })],
    ["browserStartHumanControl", () => A.browserStartHumanControl(cdpWith().asCdp(), {})],
    ["browserStopHumanControl", () => A.browserStopHumanControl(cdpWith().asCdp(), {})],
  ];

  for (const [name, run] of needsBoth) {
    it(`${name} is refused at this layer when windowId/tabId is missing, and never sent`, async () => {
      const r = await run();
      assert.equal(r.ok, false);
      assert.match(r.text, /missing required parameter/);
      assert.match(r.text, /windowId/);
      assert.match(r.text, /tabId/);
    });
  }

  it("browserAddNewTab needs only windowId, and is likewise refused here without it", async () => {
    const r = await A.browserAddNewTab(cdpWith().asCdp(), { url: "https://a.test/" });
    assert.equal(r.ok, false);
    assert.match(r.text, /missing required parameter windowId/);
  });

  it("browserCloseWindow is refused at this layer without a windowId", async () => {
    const r = await A.browserCloseWindow(cdpWith().asCdp(), {});
    assert.equal(r.ok, false);
    assert.match(r.text, /missing required parameter windowId/);
  });

  it("when refused, not one command is actually sent", async () => {
    const cdp = cdpWith();
    await A.browserNavigate(cdp.asCdp(), { url: "https://a.test/" });
    assert.deepEqual(cdp.calls, []);
  });

  it("an empty string and pure whitespace are treated the same as missing", async () => {
    const r = await A.browserClick(cdpWith().asCdp(), {
      emsn: 1,
      windowId: "  ",
      tabId: "",
      ...SNAP,
    });
    assert.equal(r.ok, false);
    assert.match(r.text, /missing required parameter/);
  });
});

describe("browser-actions: browserReload and formResubmission", () => {
  it("does not resubmit the form by default, and hands the risk to the caller in the kernel's own words", async () => {
    const cdp = cdpWith({
      "Embiody.browserReload": () => navReply({ loadStatus: "formResubmission" }),
    });
    const r = await A.browserReload(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /formResubmission/);
    assert.match(r.text, /second charge|send it again/);
    assert.match(r.text, /resubmitForm/);
    assert.equal(cdp.lastCall("Embiody.browserReload").params.resubmitForm, false);
  });

  it("only an explicit resubmitForm=true is passed through", async () => {
    const cdp = cdpWith();
    await A.browserReload(cdp.asCdp(), { ...TARGET, resubmitForm: true });
    assert.equal(cdp.lastCall("Embiody.browserReload").params.resubmitForm, true);
  });

  it("bypassCache defaults to false and changes only when given", async () => {
    const cdp = cdpWith();
    await A.browserReload(cdp.asCdp(), { ...TARGET });
    assert.equal(cdp.lastCall("Embiody.browserReload").params.bypassCache, false);
    await A.browserReload(cdp.asCdp(), { ...TARGET, bypassCache: true });
    assert.equal(cdp.lastCall("Embiody.browserReload").params.bypassCache, true);
  });
});

describe("browser-actions: history navigation with nowhere to go is a hard error", () => {
  it("browserGoBack refused by the kernel with no earlier entry -> say plainly not to retry", async () => {
    const cdp = cdpWith({
      "Embiody.browserGoBack": () =>
        new Error("Cannot go back: this tab has no earlier entry"),
    });
    const r = await A.browserGoBack(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /Go back failed: this tab has no history entry/);
    assert.match(r.text, /Do not retry/);
    assert.match(r.text, /browserNavigate/);
  });

  it("browserGoForward likewise", async () => {
    const cdp = cdpWith({
      "Embiody.browserGoForward": () =>
        new Error("Cannot go forward: this tab has no later entry"),
    });
    const r = await A.browserGoForward(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /Go forward failed: this tab has no history entry/);
  });

  it("other errors are not mistaken for 'no history entry'", async () => {
    const cdp = cdpWith({
      "Embiody.browserGoBack": () => new Error("Target closed"),
    });
    const r = await A.browserGoBack(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /Target closed/);
    assert.doesNotMatch(r.text, /no history entry to move to/);
  });
});

describe("browser-actions: replies holding only wasLoading / muted", () => {
  it("browserStopLoading's wasLoading=false is not a failure", async () => {
    const cdp = cdpWith({ "Embiody.browserStopLoading": { wasLoading: false } });
    const r = await A.browserStopLoading(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /had already finished loading/);
    assert.equal(r.data?.wasLoading, false);
  });

  it("browserStopLoading's wasLoading=true shows a load really was stopped", async () => {
    const cdp = cdpWith({ "Embiody.browserStopLoading": { wasLoading: true } });
    const r = await A.browserStopLoading(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /Loading stopped/);
  });

  it("browserSetAudioMuted goes by the muted read back, not an echo of the request", async () => {
    // The kernel states that muted is read back from the tab. This builds a "asked to mute, did not actually mute" case.
    const cdp = cdpWith({
      "Embiody.browserSetAudioMuted": () => ({ muted: false, success: true }),
    });
    const r = await A.browserSetAudioMuted(cdp.asCdp(), { muted: true, ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /Tab unmuted/, "it should reflect the false read back, not the true that was requested");
  });
});

describe("browser-actions：browserClosePopupBubble", () => {
  it("having no popup to close is not a failure", async () => {
    const cdp = cdpWith({
      "Embiody.browserClosePopupBubble": { closed: false, types: [] },
    });
    const r = await A.browserClosePopupBubble(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /Nothing was closed/);
  });

  it("when one is closed, the types are reported", async () => {
    const cdp = cdpWith({
      "Embiody.browserClosePopupBubble": {
        closed: true,
        types: ["permission", "menu"],
      },
    });
    const r = await A.browserClosePopupBubble(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /permission, menu/);
  });

  it("action defaults to dismiss", async () => {
    const cdp = cdpWith();
    await A.browserClosePopupBubble(cdp.asCdp(), { ...TARGET });
    assert.equal(
      cdp.lastCall("Embiody.browserClosePopupBubble").params.action,
      "dismiss",
    );
  });
});

describe("browser-actions: the popups a snapshot brings back (scoped in three layers)", () => {
  it("a tab's own popups are read out with every field", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {
          popups: [
            {
              type: "permission",
              message: "example.com wants to know your location",
              availableActions: ["allowOnce", "allow", "deny", "dismiss", "ignore"],
            },
            { type: "modalDialog", availableActions: ["dismiss"] },
          ],
        }),
    });
    const snap = await A.takeSnapshot(cdp.asCdp(), { ...TARGET });
    assert.equal(snap.popups.length, 2);
    assert.equal(snap.popups[0].type, "permission");
    assert.match(snap.popups[0].message!, /wants to know your location/);
    assert.deepEqual(snap.popups[1].availableActions, ["dismiss"]);
  });

  it("no popups field counts as no popups; nothing is invented", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { popups: undefined }),
    });
    assert.deepEqual((await A.takeSnapshot(cdp.asCdp(), { ...TARGET })).popups, []);
  });

  it("a misshapen entry is dropped (an empty type is not a popup)", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { popups: [null, {}, { type: "" }, { type: "permission" }] }),
    });
    const snap = await A.takeSnapshot(cdp.asCdp(), { ...TARGET });
    assert.deepEqual(snap.popups.map((x) => x.type), ["permission"]);
  });

  it("nothing is written to disk unless EMBIODY_SAVE_SNAPSHOTS=1", async () => {
    await A.takeSnapshots(cdpWith().asCdp(), { targets: [{ windowId: "900", tabId: "1001" }] });
    assert.equal(fs.existsSync(process.env.EMBIODY_SNAPSHOT_DIR!), false);
  });

  it("window-level popups are filed on the window and never mixed into any tab", async () => {
    // This is what the three-layer scoping set out to fix: capturing three tabs of one window used to report
    // that window's menu once per item, and reading "the second tab has a menu open" is a falsehood —
    // the menu belongs to the window.
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        const r = snapshotReply(p) as any;
        r.windows[0].popups = [{ type: "menu", availableActions: ["dismiss"] }];
        return r;
      },
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
      ],
    });
    assert.deepEqual(
      batch.windowPopups.get("900")?.map((x) => x.type),
      ["menu"],
    );
    for (const s of batch.snapshots) {
      assert.deepEqual(s.popups, [], "a window's menu must not appear on a tab");
    }
  });

  // A minimized window paints nothing for a page it navigated to meanwhile. The browser answers
  // with good numbers and no picture, and says so; dropping the whole snapshot threw that away.
  it("no picture is not a failure: the numbers are kept and the browser's reason recorded", async () => {
    const note = "There is no picture in this reply: none could be had within 15000 ms.";
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        const r = snapshotReply(p) as any;
        delete r.windows[0].tabs[0].annotatedImage;
        r.windows[0].tabs[0].message = note;
        return r;
      },
    });
    const shot = await A.takeSnapshot(cdp.asCdp(), { windowId: "900", tabId: "1001" });
    assert.equal(shot.annotatedImage, undefined);
    assert.equal(shot.noImageReason, note);
    assert.equal(shot.loadingMessage, undefined, "it is not the captured-while-loading note");
    assert.ok(shot.emsnLines?.size, "the numbers are kept");
  });

  it("image: false asks the browser for no picture at all", async () => {
    const cdp = cdpWith();
    await A.takeSnapshot(cdp.asCdp(), { windowId: "900", tabId: "1001", image: false });
    const tab = (cdp.lastCall("Embiody.browserTakeSnapshot").params.targets as any)[0].tabs[0];
    assert.equal(tab.returnAnnotatedImage, false);
    assert.equal(tab.returnImage, false);
  });

  it("browser-level popups are reported once for the whole batch", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        const r = snapshotReply(p) as any;
        r.browserPopups = [{ type: "taskManager", availableActions: ["dismiss"] }];
        return r;
      },
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
      ],
    });
    assert.deepEqual(batch.browserPopups.map((x) => x.type), ["taskManager"]);
  });
});

describe("browser-actions: the five actions of browserClosePopupBubble", () => {
  for (const a of ["allowOnce", "allow", "deny", "dismiss", "ignore", "ALLOW", "Dismiss"]) {
    it(`action=${a} passes through (case insensitive)`, async () => {
      const cdp = cdpWith();
      const r = await A.browserClosePopupBubble(cdp.asCdp(), {
        action: a,
        ...TARGET,
      });
      assert.equal(r.ok, true, r.text);
      assert.equal(
        cdp.lastCall("Embiody.browserClosePopupBubble").params.action,
        a,
        "sent verbatim, for the kernel to validate by its own rules",
      );
    });
  }

  it("a value outside the five is refused at this layer, pointing at the conservative option", async () => {
    const cdp = cdpWith();
    const r = await A.browserClosePopupBubble(cdp.asCdp(), {
      action: "accept",
      ...TARGET,
    });
    assert.equal(r.ok, false);
    assert.ok(r.text.includes("allowOnce/allow/deny/dismiss/ignore"), r.text);
    assert.match(r.text, /dismiss/);
    assert.deepEqual(cdp.calls, [], "it must not be sent");
  });

  it("defaults to dismiss (the most conservative: refuse without writing to the profile)", async () => {
    const cdp = cdpWith();
    await A.browserClosePopupBubble(cdp.asCdp(), { ...TARGET });
    assert.equal(
      cdp.lastCall("Embiody.browserClosePopupBubble").params.action,
      "dismiss",
    );
  });

  it("appliedAction is carried out; allow/deny additionally say it was written into the profile", async () => {
    for (const [applied, mustWarn] of [
      ["allow", true],
      ["deny", true],
      ["dismiss", false],
      ["allowOnce", false],
    ] as const) {
      const cdp = cdpWith({
        "Embiody.browserClosePopupBubble": {
          closed: true,
          types: ["permission"],
          appliedAction: applied,
        },
      });
      const r = await A.browserClosePopupBubble(cdp.asCdp(), {
        action: applied,
        ...TARGET,
      });
      assert.equal(r.ok, true, r.text);
      assert.equal(r.data?.appliedAction, applied);
      assert.match(r.text, new RegExp(applied));
      assert.equal(
        /written into the browser profile/.test(r.text),
        mustWarn,
        `${applied}: the persistence warning should ${mustWarn ? "appear" : "not appear"}`,
      );
    }
  });

  it("with no permission bubble to answer, appliedAction is absent (which is not the same as an empty string)", async () => {
    const cdp = cdpWith({
      "Embiody.browserClosePopupBubble": {
        closed: true,
        types: ["menu"],
      },
    });
    const r = await A.browserClosePopupBubble(cdp.asCdp(), { ...TARGET });
    assert.equal(r.data?.appliedAction, undefined);
    assert.doesNotMatch(r.text, /to the permission bubble/);
  });
});

describe("browser-actions: human handover", () => {
  it("startHumanControl defaults to showWindow=true (a person has to see the window to type into it)", async () => {
    const cdp = cdpWith();
    await A.browserStartHumanControl(cdp.asCdp(), { ...TARGET });
    assert.equal(
      cdp.lastCall("Embiody.browserStartHumanControl").params.showWindow,
      true,
    );
  });

  it("the success message must say plainly that everything except snapshots will fail", async () => {
    const r = await A.browserStartHumanControl(cdpWith().asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /snapshots/);
    assert.match(r.text, /browserStopHumanControl/);
    assert.equal(r.data?.humanControl, true);
  });

  it("the person took over and refuses to give it back -> ok=false, carrying the reason", async () => {
    const cdp = cdpWith({
      "Embiody.browserStopHumanControl": {
        success: false,
        reason: "userTookOver",
      },
    });
    const r = await A.browserStopHumanControl(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /userTookOver/);
    assert.match(r.text, /has not given it back/);
  });

  it("reason=none means it was never taken over, which is normal", async () => {
    const cdp = cdpWith({
      "Embiody.browserStopHumanControl": { success: true, reason: "none" },
    });
    const r = await A.browserStopHumanControl(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /was not under human control/);
  });
});

describe("browser-actions: clicking and typing", () => {
  it("with an emsn, no coordinates are sent (sending them gives up the kernel's occlusion check)", async () => {
    const cdp = cdpWith();
    await A.browserClick(cdp.asCdp(), { emsn: 7, x: 10, y: 20, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserClick");
    assert.equal(call.params.emsn, 7);
    assert.ok(!call.wireKeys.includes("x"), "with an emsn, x must not be sent");
    assert.ok(!call.wireKeys.includes("y"), "with an emsn, y must not be sent");
  });

  it("coordinates are only sent when there is no emsn", async () => {
    const cdp = cdpWith();
    await A.browserClick(cdp.asCdp(), { x: 10, y: 20, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserClick");
    assert.equal(call.params.x, 10);
    assert.equal(call.params.y, 20);
    assert.ok(!call.wireKeys.includes("emsn"));
  });

  it("neither an emsn nor a complete pair of coordinates -> refused", async () => {
    const r = await A.browserClick(cdpWith().asCdp(), { x: 10, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /requires either emsn or x,y/);
  });

  it("the kernel's message (the snapshot is stale) reaches the model verbatim", async () => {
    const cdp = cdpWith({
      "Embiody.browserClick": {
        success: true,
        message: "element moved; take a fresh snapshot",
      },
    });
    const r = await A.browserClick(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.match(r.text, /kernel note: element moved/);
  });

  it("an input focus timeout retries once, and a second success is a success", async () => {
    let n = 0;
    const cdp = cdpWith({
      "Embiody.browserInputText": () => {
        n += 1;
        return n === 1
          ? new Error("the frame did not take input focus within 10s")
          : { success: true };
      },
    });
    const r = await A.browserInputText(cdp.asCdp(), { text: "hi", ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.equal(cdp.callsTo("Embiody.browserInputText").length, 2);
  });

  it("errors other than a focus timeout are not retried", async () => {
    let n = 0;
    const cdp = cdpWith({
      "Embiody.browserInputText": () => {
        n += 1;
        return new Error("emsn 7 no longer exists in the page");
      },
    });
    const r = await A.browserInputText(cdp.asCdp(), { text: "hi", ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.equal(n, 1, "a non-retryable error must not be retried");
  });
});

describe("browser-actions: typing at a place", () => {
  it("sends the place, and quotes the lines read back", async () => {
    const cdp = cdpWith({ "Embiody.browserInputText": { success: true, editedText: '好的，‸我很"喜欢"\t' } });
    const r = await A.browserInputText(cdp.asCdp(), {
      text: "",
      emsn: 7,
      replace: "收到，\n",
      occurrence: 2,
      ...TARGET,
      ...SNAP,
    });
    const call = cdp.lastCall("Embiody.browserInputText");
    assert.equal(call.params.replace, "收到，\n");
    assert.equal(call.params.occurrence, 2);
    assert.equal(call.params.text, "", "empty text with replace deletes, so it must reach the kernel as is");
    assert.ok(!call.wireKeys.includes("before") && !call.wireKeys.includes("at"), "unset places stay off the wire");
    assert.equal(r.ok, true);
    assert.match(r.text, /now reads: "好的，‸我很\\"喜欢\\"\\t"$/);
  });

  it("without editedText (not read back, e.g. an editor drawing elsewhere) the reply says nothing about it", async () => {
    const r = await A.browserInputText(cdpWith().asCdp(), { text: "hi", ...TARGET, ...SNAP });
    assert.equal(r.text, "Text typed (clearText=false, pressEnter=false)");
  });

  it("a read-back mismatch is a failure carrying the kernel's words, and is not retried", async () => {
    const cdp = cdpWith({
      "Embiody.browserInputText": new Error("The text was typed, but emsn 7's text is not what that should make"),
    });
    const r = await A.browserInputText(cdp.asCdp(), { text: "x", emsn: 7, after: "a", ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Typing failed: The text was typed/);
    assert.equal(cdp.callsTo("Embiody.browserInputText").length, 1, "typed already: a retry would type it twice");
  });
});

describe("browser-actions: pressing keys", () => {
  it("sends the keys and focus target, and names what was pressed", async () => {
    const cdp = cdpWith();
    const keys = [{ key: "End" }, { key: "ArrowLeft", repeatCount: 2 }, { key: "Enter", repeatCount: 1 }];
    const r = await A.browserPressKey(cdp.asCdp(), { keys, emsn: 7, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserPressKey");
    assert.deepEqual(call.params.keys, keys);
    assert.equal(call.params.emsn, 7);
    assert.equal(call.params.snapshotId, SNAP.snapshotId);
    assert.ok(!call.wireKeys.includes("repeatDelayMs"), "unset, the kernel's default applies");
    assert.equal(r.text, "Pressed End, ArrowLeft x2, Enter");
  });

  it("a refused key is a failure carrying the kernel's reason", async () => {
    const cdp = cdpWith({
      "Embiody.browserPressKey": new Error('"Control+W" is the browser\'s shortcut for closing the tab. Nothing was pressed'),
    });
    const r = await A.browserPressKey(cdp.asCdp(), { keys: [{ key: "Control+W" }], ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Key press failed: "Control\+W" is the browser's shortcut/);
    assert.equal(cdp.callsTo("Embiody.browserPressKey").length, 1);
  });

  it("success: false without a message still fails", async () => {
    const r = await A.browserPressKey(cdpWith({ "Embiody.browserPressKey": { success: false } }).asCdp(), {
      keys: [{ key: "Tab" }],
      ...TARGET,
      ...SNAP,
    });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Key press failed:/);
  });

  it("a focus timeout (no key pressed) retries once", async () => {
    let n = 0;
    const cdp = cdpWith({
      "Embiody.browserPressKey": () =>
        ++n === 1
          ? new Error("Keyboard focus did not reach the element's frame in time, so no key was pressed.")
          : { success: true },
    });
    const r = await A.browserPressKey(cdp.asCdp(), { keys: [{ key: "Escape" }], emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.equal(cdp.callsTo("Embiody.browserPressKey").length, 2);
  });

  it("a second focus timeout is reported, not retried again", async () => {
    const cdp = cdpWith({
      "Embiody.browserPressKey": () => new Error("Keyboard focus did not reach the element's frame in time"),
    });
    const r = await A.browserPressKey(cdp.asCdp(), { keys: [{ key: "Escape" }], emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.equal(cdp.callsTo("Embiody.browserPressKey").length, 2);
  });
});

describe("browser-actions: selecting text", () => {
  it("sends only the way of selecting given, and quotes the marked lines", async () => {
    const cdp = cdpWith({ "Embiody.browserSelectEditableText": { success: true, selectedText: "我很⟦喜欢这个⟧方案" } });
    const r = await A.browserSelectEditableText(cdp.asCdp(), { emsn: 7, from: "喜欢", to: "这个", toOccurrence: 2, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserSelectEditableText");
    assert.deepEqual(
      [...call.wireKeys].sort(),
      ["emsn", "from", "snapshotId", "tabId", "to", "toOccurrence", "windowId"],
    );
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Selected: "我很⟦喜欢这个⟧方案"');
  });

  it("a refusal carries the kernel's words and is not retried", async () => {
    const cdp = cdpWith({
      "Embiody.browserSelectEditableText": new Error("'好' is in 3 places in emsn 7; say which with occurrence. Nothing was selected."),
    });
    const r = await A.browserSelectEditableText(cdp.asCdp(), { emsn: 7, select: "好", ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /^Selecting failed: '好' is in 3 places/);
    assert.equal(cdp.callsTo("Embiody.browserSelectEditableText").length, 1);
  });

  it("a focus timeout (nothing selected) retries once", async () => {
    let n = 0;
    const cdp = cdpWith({
      "Embiody.browserSelectEditableText": () =>
        ++n === 1
          ? new Error("The element was clicked, but its frame did not take input focus in time, so nothing was selected.")
          : { success: true, selectedText: "⟦x⟧" },
    });
    const r = await A.browserSelectEditableText(cdp.asCdp(), { emsn: 7, all: true, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.equal(cdp.callsTo("Embiody.browserSelectEditableText").length, 2);
  });
});

describe("browser-actions: scrolling", () => {
  // A September 2026 kernel change renamed xDistance/yDistance; until late October 2026 the kernel ignored unknown names, so an old
  // name earned success with a page that never moved.
  it("sends deltaY, never the retired yDistance; a zero axis stays off the wire", async () => {
    const cdp = cdpWith();
    await A.browserScroll(cdp.asCdp(), { deltaX: 0, deltaY: 400, ...TARGET });
    const call = cdp.lastCall("Embiody.browserScroll");
    assert.deepEqual(call.wireKeys.sort(), ["deltaY", "tabId", "windowId"]);
    assert.equal(call.params.deltaY, 400);
  });

  it("neither how far nor where to -> refused", async () => {
    const r = await A.browserScroll(cdpWith().asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /deltaY.*toY/);
  });

  it("how far and where to together -> refused before the wire", async () => {
    const cdp = cdpWith();
    const r = await A.browserScroll(cdp.asCdp(), { deltaY: 100, toY: 0, ...TARGET });
    assert.equal(r.ok, false);
    assert.equal(cdp.callsTo("Embiody.browserScroll").length, 0);
  });

  it("toY with a repeat -> refused", async () => {
    const r = await A.browserScroll(cdpWith().asCdp(), { toY: 0, repeatCount: 3, ...TARGET });
    assert.equal(r.ok, false);
  });

  it("toY: 0 is sent (0 means the top, not 'absent')", async () => {
    const cdp = cdpWith();
    await A.browserScroll(cdp.asCdp(), { toY: 0, ...TARGET });
    assert.equal(cdp.lastCall("Embiody.browserScroll").params.toY, 0);
  });

  it("aimed at an element: onEmsn goes out with the snapshotId, and without one it is refused", async () => {
    const cdp = cdpWith();
    await A.browserScroll(cdp.asCdp(), { deltaY: 300, onEmsn: 3, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserScroll");
    assert.equal(call.params.onEmsn, 3);
    assert.equal(call.params.snapshotId, SNAP.snapshotId);

    const r = await A.browserScroll(cdpWith().asCdp(), { deltaY: 300, onEmsn: 3, ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /snapshotId/);
  });

  it("not aimed: no snapshotId needed, none sent", async () => {
    const cdp = cdpWith();
    const r = await A.browserScroll(cdp.asCdp(), { toY: 999999, ...TARGET });
    assert.equal(r.ok, true);
    assert.ok(!cdp.lastCall("Embiody.browserScroll").wireKeys.includes("snapshotId"));
  });
});

describe("browser-actions: hovering", () => {
  it("with an emsn, no coordinates are sent — a point would bypass the kernel's checks, as with click", async () => {
    const cdp = cdpWith();
    await A.browserMove(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserMove");
    assert.equal(call.params.emsn, 7);
    assert.ok(!call.wireKeys.includes("x") && !call.wireKeys.includes("y"));
  });

  it("emsn plus x,y names a spot inside that element, so both go on the wire", async () => {
    const cdp = cdpWith();
    await A.browserMove(cdp.asCdp(), { emsn: 7, x: 3, y: 4, ...TARGET, ...SNAP });
    const call = cdp.lastCall("Embiody.browserMove");
    assert.deepEqual([call.params.emsn, call.params.x, call.params.y], [7, 3, 4]);
  });

  it("neither an emsn nor a complete point -> refused before anything is sent", async () => {
    const cdp = cdpWith();
    const r = await A.browserMove(cdp.asCdp(), { ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /either emsn or x,y/);
    assert.equal(cdp.calls.length, 0);
  });

  it("x without y -> refused rather than quietly hovering the element's centre instead", async () => {
    const cdp = cdpWith();
    const r = await A.browserMove(cdp.asCdp(), { emsn: 7, x: 3, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /both x and y/);
    assert.equal(cdp.calls.length, 0);
  });

  it("the reply's point is reported back: an emsn is aimed at the live centre, not at where the snapshot put it", async () => {
    const cdp = cdpWith({ "Embiody.browserMove": { success: true, x: 88, y: 99 } });
    const r = await A.browserMove(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.match(r.text, /\(88, 99\)/);
  });

  it("success:false is a failure, not a hover that happened", async () => {
    const cdp = cdpWith({ "Embiody.browserMove": { success: false, error: "element is gone" } });
    const r = await A.browserMove(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /element is gone/);
  });

  it("the kernel's \"the page moved under me\" note survives into a successful reply", async () => {
    const cdp = cdpWith({
      "Embiody.browserMove": { success: true, x: 1, y: 2, message: "take a fresh snapshot" },
    });
    const r = await A.browserMove(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.match(r.text, /take a fresh snapshot/);
  });
});

describe("browser-actions: dragging", () => {
  it("each of the three ways of naming the destination goes on the wire as itself", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ toEmsn: 9 }, { toEmsn: 9 }],
      [{ toX: 30, toY: 40 }, { toX: 30, toY: 40 }],
      [{ dx: 120, dy: 0 }, { dx: 120, dy: 0 }],
    ];
    for (const [given, expected] of cases) {
      const cdp = cdpWith();
      await A.browserDrag(cdp.asCdp(), { emsn: 7, ...given, ...TARGET, ...SNAP });
      const call = cdp.lastCall("Embiody.browserDrag");
      for (const [k, v] of Object.entries(expected)) {
        assert.equal(call.params[k], v, `${k} should reach the wire`);
      }
    }
  });

  it("no destination at all -> refused, and the refusal names all three ways", async () => {
    const cdp = cdpWith();
    const r = await A.browserDrag(cdp.asCdp(), { emsn: 7, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    for (const way of ["toEmsn", "toX", "dx"]) assert.match(r.text, new RegExp(way));
    assert.equal(cdp.calls.length, 0);
  });

  it("mixing a destination with an offset -> refused (the kernel refuses it too, but says less)", async () => {
    const cdp = cdpWith();
    const r = await A.browserDrag(cdp.asCdp(), { emsn: 7, toEmsn: 9, dx: 10, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.equal(cdp.calls.length, 0);
  });

  it("half a coordinate pair -> refused, at either end and even alongside an emsn", async () => {
    // With an emsn present, a lone toX would otherwise be dropped on the way to the wire and the
    // drag would land somewhere the caller never asked for.
    const halves: Array<[Record<string, unknown>, RegExp]> = [
      [{ emsn: 7, toX: 30 }, /both toX and toY/],
      [{ emsn: 7, toEmsn: 9, toY: 40 }, /both toX and toY/],
      [{ x: 10, toEmsn: 9 }, /both x and y/],
    ];
    for (const [given, expected] of halves) {
      const cdp = cdpWith();
      const r = await A.browserDrag(cdp.asCdp(), { ...given, ...TARGET, ...SNAP });
      assert.equal(r.ok, false, JSON.stringify(given));
      assert.match(r.text, expected);
      assert.equal(cdp.calls.length, 0);
    }
  });

  it("both ends of the reply are reported: the pointer is left at the far one", async () => {
    const cdp = cdpWith({
      "Embiody.browserDrag": { success: true, x: 1, y: 2, toX: 3, toY: 4 },
    });
    const r = await A.browserDrag(cdp.asCdp(), { emsn: 7, toEmsn: 9, ...TARGET, ...SNAP });
    assert.equal(r.ok, true);
    assert.match(r.text, /\(1, 2\) -> \(3, 4\)/);
  });
});

describe("browser-actions: what kind of page was photographed (pageType)", () => {
  it("the entry's own url wins over the one the caller asked for: a download or a 204 leaves the tab elsewhere", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: any) =>
        snapshotReply(p, { url: "https://landed.test/" }),
    });
    const shot = await A.takeSnapshot(cdp.asCdp(), {
      ...TARGET,
      url: "https://asked-for.test/",
    });
    assert.equal(shot.url, "https://landed.test/");
  });

  it("with no url in the entry (the tab went away before it could be read), the requested one is kept", async () => {
    const shot = await A.takeSnapshot(cdpWith().asCdp(), {
      ...TARGET,
      url: "https://asked-for.test/",
    });
    assert.equal(shot.url, "https://asked-for.test/");
  });

  it("each non-normal pageType reaches the caller with what it means for the next move", async () => {
    for (const [pageType, expected] of [
      ["plugin", /PDF/],
      ["error", /browser's own error page/],
      ["crashed", /renderer is gone/],
    ] as const) {
      const cdp = cdpWith({
        "Embiody.browserTakeSnapshot": (p: any) => snapshotReply(p, { pageType }),
      });
      const shot = await A.takeSnapshot(cdp.asCdp(), { ...TARGET });
      assert.equal(shot.pageType, pageType);
      assert.match(A.describePageType(shot.pageType)!, expected);
    }
  });

  it("a normal page says nothing extra — a note on every snapshot would be noise", () => {
    assert.equal(A.describePageType("normal"), undefined);
    assert.equal(A.describePageType(undefined), undefined);
    // A value the kernel adds later must not be described as something we recognise.
    assert.equal(A.describePageType("something-new"), undefined);
  });

  it("an error or crashed page makes recapture pointless, whatever the message says", () => {
    // The message alone would have this retried: nothing in it matches the deterministic list.
    const failure = { tabId: "1001", reason: "empty", raw: "empty element list" };
    assert.equal(A.snapshotRetryIsPointless(failure), false);
    assert.equal(A.snapshotRetryIsPointless({ ...failure, pageType: "error" }), true);
    assert.equal(A.snapshotRetryIsPointless({ ...failure, pageType: "crashed" }), true);
    // A PDF is not a failure to recapture: the viewer's controls really are there.
    assert.equal(A.snapshotRetryIsPointless({ ...failure, pageType: "plugin" }), false);
  });
});

describe("browser-actions: the shape of takeSnapshot / takeSnapshots", () => {
  it("sends the targets tree, no longer windowId/tabId/returnAnnotatedContent", async () => {
    const cdp = cdpWith();
    await A.takeSnapshot(cdp.asCdp(), { ...TARGET });
    const call = cdp.lastCall("Embiody.browserTakeSnapshot");
    assert.deepEqual(call.params.targets, [
      {
        windowId: TARGET.windowId,
        tabs: [
          { tabId: TARGET.tabId, returnImage: true, returnAnnotatedImage: true },
        ],
      },
    ]);
    // These were removed when the targets tree came in (September 2026). They were silently ignored then; since late October 2026 the kernel refuses the whole call.
    for (const gone of ["windowId", "tabId", "returnAnnotatedContent", "includeBrowserFrame"]) {
      assert.ok(
        !call.wireKeys.includes(gone),
        `${gone} was removed from the pdl and must no longer be sent`,
      );
    }
  });

  it("returnImage follows the config (snapshot.returnImage) and is on by default", async () => {
    // It was originally hard-coded to false on the grounds that the annotated image is a superset of the
    // raw one. **That reasoning was wrong**: the number labels cover the elements they label, badly so on
    // dense controls (in Ctrip's calendar, adjacent numbers like 161/162 and 150/149 overlap and the
    // dates in the cells become unreadable). The two are pixel aligned, so the model can read the covered
    // content back off the raw one by coordinate; measured, images are 8% of the prompt.
    const cdp = cdpWith();
    await A.takeSnapshots(cdp.asCdp(), {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
      ],
    });
    const tabs = (cdp.lastCall("Embiody.browserTakeSnapshot").params as any)
      .targets[0].tabs;
    assert.deepEqual(
      tabs.map((t: any) => t.returnImage),
      [true, true],
      "the raw image should be requested by default too",
    );
    // returnAnnotatedImage is always wanted — the numbers exist only on the annotated image.
    assert.deepEqual(
      tabs.map((t: any) => t.returnAnnotatedImage),
      [true, true],
    );
  });

  it("a window is sent once and a tab is sent once (a duplicate makes the kernel refuse the whole command)", async () => {
    const cdp = cdpWith();
    await A.takeSnapshots(cdp.asCdp(), {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
        { windowId: "900", tabId: "1001" },
        { windowId: "901", tabId: "2001" },
      ],
    });
    const targets = (cdp.lastCall("Embiody.browserTakeSnapshot").params as any)
      .targets;
    assert.deepEqual(
      targets.map((t: any) => t.windowId),
      ["900", "901"],
      "one window must be merged into a single entry",
    );
    assert.deepEqual(
      targets[0].tabs.map((t: any) => t.tabId),
      ["1001", "1002"],
      "a duplicate tab must be dropped",
    );
  });

  it("reads annotatedContent and carries windowId/tabId/url out with it", async () => {
    const snap = await A.takeSnapshot(cdpWith().asCdp(), {
      ...TARGET,
      url: "https://a.test/",
      title: "a title",
    });
    assert.ok(snap.annotatedContent.length > 0);
    assert.equal(snap.annotatedImage, "UE5H-annotated");
    assert.equal(snap.tabId, TARGET.tabId, "with several tabs this is what matches an image to its tab");
    assert.equal(snap.windowId, TARGET.windowId);
    assert.equal(snap.url, "https://a.test/");
    assert.equal(snap.title, "a title");
  });

  it("a reply without the raw image leaves image unset (it is optional)", async () => {
    const snap = await A.takeSnapshot(cdpWith().asCdp(), { ...TARGET });
    assert.equal(
      (snap as unknown as Record<string, unknown>).image,
      undefined,
    );
  });

  it("one tab failing in a batch leaves the others returning as usual", async () => {
    // The most important behavioural change in batch snapshots (September 2026): one tab's problem no longer errors the whole command.
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {}, (tabId) =>
          tabId === "1002"
            ? { success: false, message: "This tab's renderer is gone" }
            : undefined,
        ),
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
      ],
    });
    assert.deepEqual(batch.snapshots.map((s) => s.tabId), ["1001"]);
    assert.deepEqual(batch.failures.map((f) => f.tabId), ["1002"]);
    assert.match(batch.failures[0].reason, /renderer is gone/);
    assert.equal(batch.failures[0].raw, "This tab's renderer is gone");
  });

  it("annotatedContent without a snapshotId -> that item counts as a failure", async () => {
    // The pdl's invariant is "a snapshotId exists if and only if annotatedContent does". Actually
    // receiving a batch with no id and using it with browserClick only buys "the element is not in the
    // latest snapshot", when the truth is that batch never existed.
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { snapshotId: undefined }),
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), {
      targets: [{ windowId: "900", tabId: "1001" }],
    });
    assert.equal(batch.snapshots.length, 0);
    assert.match(batch.failures[0].reason, /got no element numbers/);
  });

  it("a reply tree that does not line up with the request fails the whole batch, never indexing by a shifted position", async () => {
    // The consequence of a shift is taking tab A's numbers for tab B's, with the model then acting on a
    // different page. That is far worse than "no images this round", so failing the whole batch is better.
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": () => ({ windows: [], browserPopups: [] }),
    });
    await assert.rejects(
      () =>
        A.takeSnapshots(cdp.asCdp(), {
          targets: [{ windowId: "900", tabId: "1001" }],
        }),
      /cannot be matched positionally/,
    );
  });

  it("a tabId in the reply that differs from the request also fails the whole batch", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        const r = snapshotReply(p) as any;
        r.windows[0].tabs[0].tabId = "9999";
        return r;
      },
    });
    await assert.rejects(
      () =>
        A.takeSnapshots(cdp.asCdp(), {
          targets: [{ windowId: "900", tabId: "1001" }],
        }),
      /came back for tab 9999/,
    );
  });

  it("throws when windowId/tabId is missing (a snapshot failure must be explicit, so the layer above can retry)", async () => {
    await assert.rejects(
      () => A.takeSnapshot(cdpWith().asCdp(), {}),
      /missing required parameter/,
    );
  });
});

describe("browser-actions: hideWindow on browserNewWindow", () => {
  it("sends hideWindow, no longer the retired showHead", async () => {
    const cdp = cdpWith();
    await A.browserNewWindow(cdp.asCdp(), { url: "https://a.test/" });
    const call = cdp.lastCall("Embiody.browserNewWindow");
    assert.equal(call.params.hideWindow, false, "the window is shown by default");
    assert.ok(!call.wireKeys.includes("showHead"), "showHead disappeared in an early protocol revision");
  });

  it("hideWindow=true passes through", async () => {
    const cdp = cdpWith();
    await A.browserNewWindow(cdp.asCdp(), { hideWindow: true });
    assert.equal(cdp.lastCall("Embiody.browserNewWindow").params.hideWindow, true);
  });
});

describe("browser-actions: never turn undefined into a fake id", () => {
  // String(undefined) === "undefined". A fake id like that is taken for a valid working target, after
  // which every command reports "No Tab found" while the real cause (the kernel gave no id) is invisible.
  const badReplies: Array<[string, unknown]> = [
    ["no id at all", { success: true }],
    ["only a windowId", { success: true, windowId: "901" }],
    ["the ids are empty strings", { success: true, windowId: "", tabId: "" }],
    ["the ids are pure whitespace", { success: true, windowId: "  ", tabId: " " }],
    ["the ids are null", { success: true, windowId: null, tabId: null }],
  ];
  for (const [why, reply] of badReplies) {
    it(`browserNewWindow with ${why} -> counts as a failure and never returns "undefined"`, async () => {
      const cdp = cdpWith({ "Embiody.browserNewWindow": () => reply });
      const r = await A.browserNewWindow(cdp.asCdp(), {});
      assert.equal(r.ok, false, r.text);
      assert.match(r.text, /returned no usable windowId\/tabId/);
      assert.doesNotMatch(r.text, /windowId=undefined|tabId=undefined/);
      assert.equal(r.data, undefined, "a failure must not carry any id out");
    });
  }

  it("a numeric id is accepted too (the kernel's ids are numeric elsewhere)", async () => {
    const cdp = cdpWith({
      "Embiody.browserNewWindow": () => ({ success: true, windowId: 901, tabId: 1002 }),
    });
    const r = await A.browserNewWindow(cdp.asCdp(), {});
    assert.equal(r.ok, true, r.text);
    assert.equal(r.data?.windowId, "901");
    assert.equal(r.data?.tabId, "1002");
  });
});

describe("browser-actions: never announce an unconfirmed state on the kernel's behalf", () => {
  it("a browserSetAudioMuted reply without muted -> reported as unconfirmable, not as 'unmuted'", async () => {
    const cdp = cdpWith({
      "Embiody.browserSetAudioMuted": () => ({ success: true }),
    });
    const r = await A.browserSetAudioMuted(cdp.asCdp(), { muted: true, ...TARGET });
    assert.equal(r.ok, false, r.text);
    assert.match(r.text, /cannot be confirmed/);
    assert.doesNotMatch(r.text, /Tab muted|Tab unmuted/);
  });
});

describe("browser-actions: toState on browserShow", () => {
  it("with no toState the key is not sent (show in place, keeping the current placement)", async () => {
    const cdp = cdpWith();
    await A.browserShow(cdp.asCdp(), { windowId: "900" });
    assert.ok(!cdp.lastCall("Embiody.browserShow").wireKeys.includes("toState"));
  });

  it("Maximized shows and maximises in one hop (replacing the old three standard CDP hops)", async () => {
    const cdp = cdpWith();
    await A.browserShow(cdp.asCdp(), { windowId: "900", toState: "Maximized" });
    assert.equal(cdp.lastCall("Embiody.browserShow").params.toState, "Maximized");
    assert.deepEqual(
      cdp.methodSequence(),
      ["Embiody.browserShow"],
      "Target.getTargetInfo / Browser.getWindowForTarget / Browser.setWindowBounds should no longer be used",
    );
  });
});

describe("browser-actions: parsing browserGetWindowInfo", () => {
  it("tabs is an array of TabInfo objects, not of id strings", async () => {
    const cdp = cdpWith();
    const windows = await A.browserGetWindowInfo(cdp.asCdp());
    assert.equal(windows.length, 1);
    assert.equal(typeof windows[0].tabs[0], "object");
    assert.equal(windows[0].tabs[0].tabId, "1001");
    assert.equal(windows[0].windowState, "maximized");
  });

  it("the old shape (tabs as an array of strings) parses to an empty tabId, not [object Object]", async () => {
    // Even when connected to an old build (with the command name surviving by luck), an object and a string must not be confused into a fake tabId.
    const cdp = cdpWith({
      "Embiody.browserGetWindowInfo": () => ({
        windows: [{ windowId: "900", tabs: ["1001"] }],
        success: true,
      }),
    });
    const windows = await A.browserGetWindowInfo(cdp.asCdp());
    assert.equal(windows[0].tabs[0].tabId, "", "a string has no .tabId, so an empty string is right rather than junk");
  });

  it("success:false throws", async () => {
    const cdp = cdpWith({
      "Embiody.browserGetWindowInfo": () => ({ success: false, error: "boom" }),
    });
    await assert.rejects(() => A.browserGetWindowInfo(cdp.asCdp()), /boom/);
  });

  it("findTab locates a tab precisely by windowId plus tabId", async () => {
    const windows = [
      windowInfo({ windowId: "900", tabs: [tabInfo({ tabId: "1" })] }),
      windowInfo({
        windowId: "901",
        tabs: [tabInfo({ tabId: "2", canGoBack: true })],
      }),
    ] as unknown as A.WindowInfo[];
    assert.equal(A.findTab(windows, "901", "2")?.canGoBack, true);
    assert.equal(A.findTab(windows, "900", "2"), undefined);
    assert.equal(A.findTab(windows, "999", "1"), undefined);
  });
});

describe("browser-actions: browserAddNewTab uses the native browserNewTab", () => {
  it("gets a tabId in one hop, no longer Target.createTarget + Target.getTargetInfo", async () => {
    const cdp = cdpWith();
    const r = await A.browserAddNewTab(cdp.asCdp(), {
      windowId: "900",
      url: "https://a.test/",
    });
    assert.equal(r.ok, true);
    assert.equal(r.data?.tabId, "1002");
    assert.match(r.text, /tabId=1002/);
    assert.deepEqual(cdp.methodSequence(), ["Embiody.browserNewTab"]);
  });

  it("opens in the background by default (the foreground would steal the window from the person)", async () => {
    const cdp = cdpWith();
    await A.browserAddNewTab(cdp.asCdp(), { windowId: "900" });
    assert.equal(cdp.lastCall("Embiody.browserNewTab").params.foreground, false);
  });

  it("the default url is about:blank", async () => {
    const cdp = cdpWith();
    await A.browserAddNewTab(cdp.asCdp(), { windowId: "900" });
    assert.equal(cdp.lastCall("Embiody.browserNewTab").params.url, "about:blank");
  });
});

describe("browser-actions：browserCloseTab", () => {
  it("reports how many tabs are left", async () => {
    const cdp = cdpWith({
      "Embiody.browserCloseTab": { success: true, remainingTabsCount: 3 },
    });
    const r = await A.browserCloseTab(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /3 remaining/);
  });

  it("the user refusing to close (success:false) -> ok=false", async () => {
    const cdp = cdpWith({
      "Embiody.browserCloseTab": { success: false, remainingTabsCount: 4 },
    });
    const r = await A.browserCloseTab(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /Leave site/, "false is no longer only a refusal; say what else it can be");
  });

  // Measured on F0: a second close while the first one's "Leave site?" was up closed the tab and replied false.
  it("success:false with the tab gone from the layout -> closed after all", async () => {
    const cdp = cdpWith({
      "Embiody.browserCloseTab": { success: false, remainingTabsCount: 1 },
      "Embiody.browserGetWindowInfo": () => ({ windows: [{ windowId: TARGET.windowId, tabs: [] }] }),
    });
    const r = await A.browserCloseTab(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /0 remaining/);
  });
});

describe("browser-actions：browserWait", () => {
  // Fake timers: really sleeping 10 seconds would take this file from 0.3 seconds to 10, and all this
  // asserts is that the clamping is right, not that the wait really happened.
  it("the duration is clamped between 100 and 10000", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const cdp = cdpWith().asCdp();

    const tooSmall = A.browserWait(cdp, { durationMs: 1 });
    t.mock.timers.tick(100);
    assert.match((await tooSmall).text, /100ms/);

    const tooBig = A.browserWait(cdp, { durationMs: 999999 });
    t.mock.timers.tick(10000);
    assert.match((await tooBig).text, /10000ms/);
  });

  it("with no duration given it defaults to 2000ms", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = A.browserWait(cdpWith().asCdp(), {});
    t.mock.timers.tick(2000);
    assert.match((await p).text, /2000ms/);
  });

  it("sends no CDP command at all", async () => {
    const cdp = cdpWith();
    await A.browserWait(cdp.asCdp(), { durationMs: 100 });
    assert.deepEqual(cdp.calls, []);
  });
});

describe("browser-actions: actions that no longer exist", () => {
  it("the module no longer exports browserWaitForElement (unimplemented in the kernel; it used to claim any element had appeared)", () => {
    assert.equal(
      (A as Record<string, unknown>).browserWaitForElement,
      undefined,
    );
  });

  it("the module no longer exports browserMaximizeWindow (replaced by browserShow(toState))", () => {
    assert.equal(
      (A as Record<string, unknown>).browserMaximizeWindow,
      undefined,
    );
  });
});

describe("browser-actions: which capture failures are not worth retrying", () => {
  // The rule reads the **kernel's own words**, not the sentence we translate for the model. Matching a
  // translation against the original turns a deterministic failure into a transient one and wastes a
  // retry — which is what happened during the move to batch snapshots.
  for (const [msg, deterministic] of [
    ["No Tab found", true],
    ["Failed to capture html", true],
    ["This tab's renderer is gone -- the page crashed", true],
    ["missing snapshotId", true],
    ["renderer busy", false],
    ["This command named 80 tabs and has spent 2380 ms", false],
    // The empty replies (September 2026): each states for itself whether recapturing helps, and we match that sentence rather than the page state.
    [
      "This page is about:blank, so there is nothing on it to number. Another snapshot will say the same.",
      true,
    ],
    [
      "This page reported no elements at all. A page that has not been drawn yet reports the same thing, and a machine under heavy load is the usual reason it has not -- so if https://a.test/ is expected to have something on it, snapshot it again before concluding that it is empty.",
      false,
    ],
    // The advantage of matching the sentence rather than the page kind: new "recapturing is useless" cases they add later classify correctly on their own.
    ["Some future situation nobody has written a branch for. Another snapshot will say the same.", true],
  ] as Array<[string, boolean]>) {
    it(`${deterministic ? "no retry" : "retry once"}: ${msg.slice(0, 40)}`, () => {
      assert.equal(A.isDeterministicSnapshotFailure(msg), deterministic);
    });
  }

  it("an empty snapshot is reworded according to the sentence the kernel gave", () => {
    // The two are handled completely differently: a blank page needs navigating first, an undrawn one needs recapturing. Different wording is what makes the model change approach.
    assert.match(
      A.explainEmptySnapshot(
        "1001",
        "This page is about:blank, so there is nothing on it to number. Another snapshot will say the same.",
      ),
      /blank page.*browserNavigate/s,
    );
    assert.match(
      A.explainEmptySnapshot("1001", "This page reported no elements at all. … snapshot it again …"),
      /not rendered yet/,
    );
    // An old kernel gives no message, and there still has to be something to say.
    assert.match(A.explainEmptySnapshot("1001", undefined), /not rendered yet/);
  });

  it("the translated sentence must not be used to judge: it no longer holds the kernel's own words", () => {
    const translated = A.explainSnapshotFailure("1001", "No Tab found");
    assert.ok(!/No Tab found/.test(translated), "the translation does not contain the original");
    assert.equal(
      A.isDeterministicSnapshotFailure(translated),
      false,
      "so the failure object has to carry raw separately; see TabSnapshotFailure.raw",
    );
  });
});

describe("browser-actions: Invalid parameters must be said in plain words", () => {
  it("points at a version mismatch rather than suggesting the page is at fault", () => {
    // Hit for real: the source had followed the batch snapshot change while dist was two days behind, so the new kernel
    // received old-shaped parameters and answered only "Invalid parameters". The old fallback wording
    // was "capturing tab X failed: Invalid parameters", which gives no hint to go and check the build output.
    const m = A.explainSnapshotFailure("1001", "Invalid parameters");
    assert.match(m, /protocol shape mismatch/);
    assert.match(m, /npm run build/);
    assert.match(m, /rather than a page problem/);
  });
});

describe("browser-actions: closing when the kernel says success:false", () => {
  it("a layout that cannot be read leaves the tab reported as still open", async () => {
    const cdp = cdpWith({
      "Embiody.browserCloseTab": { success: false, remainingTabsCount: 2 },
      "Embiody.browserGetWindowInfo": () => new Error("CDP command timeout"),
    });
    const r = await A.browserCloseTab(cdp.asCdp(), { ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /still open/);
  });

  it("browserCloseWindow: gone from the layout is closed, still listed is still open", async () => {
    const gone = cdpWith({
      "Embiody.browserCloseWindow": { success: false },
      "Embiody.browserGetWindowInfo": () => ({ windows: [], success: true }),
    });
    assert.equal((await A.browserCloseWindow(gone.asCdp(), { windowId: "900" })).ok, true);

    const there = cdpWith({ "Embiody.browserCloseWindow": { success: false } });
    const r = await A.browserCloseWindow(there.asCdp(), { windowId: "900" });
    assert.equal(r.ok, false);
    assert.match(r.text, /window is still open/);
  });
});

describe("browser-actions: wait parameters of the navigation commands", () => {
  it("an unknown waitUntil and a non-positive or non-finite timeoutMs stay off the wire", async () => {
    for (const bad of [{ waitUntil: "loaded" }, { timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: Number.NaN }]) {
      const cdp = cdpWith();
      await A.browserNavigate(cdp.asCdp(), { url: "https://a.test/", ...TARGET, ...bad });
      const keys = cdp.lastCall("Embiody.browserNavigate").wireKeys;
      assert.ok(!keys.includes("waitUntil") && !keys.includes("timeoutMs"), JSON.stringify(bad));
    }
  });

  it("valid ones pass through as given", async () => {
    const cdp = cdpWith();
    await A.browserGoBack(cdp.asCdp(), { ...TARGET, waitUntil: "commit", timeoutMs: 2500 });
    const call = cdp.lastCall("Embiody.browserGoBack");
    assert.equal(call.params.waitUntil, "commit");
    assert.equal(call.params.timeoutMs, 2500);
  });
});

describe("browser-actions: scrolling, limits and deadlines", () => {
  // The kernel's timeoutMs covers every repeat; its 7 s default runs out on a long repeated scroll.
  it("a repeated scroll without timeoutMs is given more than the kernel's 7 s default", async () => {
    const cdp = cdpWith();
    await A.browserScroll(cdp.asCdp(), { deltaY: 200, repeatCount: 12, ...TARGET });
    const sent = cdp.lastCall("Embiody.browserScroll").params.timeoutMs as number;
    assert.ok(sent > 7000 + 11 * 300, `got ${sent}`);
  });

  it("a single scroll leaves timeoutMs to the kernel; an explicit one is sent as given", async () => {
    const cdp = cdpWith();
    await A.browserScroll(cdp.asCdp(), { deltaY: 200, ...TARGET });
    assert.ok(!cdp.lastCall("Embiody.browserScroll").wireKeys.includes("timeoutMs"));
    await A.browserScroll(cdp.asCdp(), { deltaY: 200, repeatCount: 12, timeoutMs: 4000, ...TARGET });
    assert.equal(cdp.lastCall("Embiody.browserScroll").params.timeoutMs, 4000);
  });

  it("onY without onX -> refused before anything is sent", async () => {
    const cdp = cdpWith();
    const r = await A.browserScroll(cdp.asCdp(), { deltaY: 100, onY: 50, ...TARGET, ...SNAP });
    assert.equal(r.ok, false);
    assert.match(r.text, /both onX and onY/);
    assert.equal(cdp.calls.length, 0);
  });

  it("a kernel deadline says the page may have moved part of the way", async () => {
    const cdp = cdpWith({
      "Embiody.browserScroll": new Error("The scroll did not come to rest within 7000 ms."),
    });
    const r = await A.browserScroll(cdp.asCdp(), { deltaY: 100, ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /part of the way; take a snapshot/);
  });
});

describe("browser-actions: browserMinimize", () => {
  it("a windowId that is not a number is refused and nothing is sent", async () => {
    const cdp = cdpWith();
    const r = await A.browserMinimize(cdp.asCdp(), { windowId: "abc" });
    assert.equal(r.ok, false);
    assert.equal(cdp.calls.length, 0);
  });

  // Browser.setWindowBounds is not behind the browser's "ask before touching a person's tab"
  // check, so the agent may minimize only a window whose every tab is AI-controlled.
  const agentWindow = (tabs: unknown[]) => ({
    "Embiody.browserGetWindowInfo": () => ({ windows: [windowInfo({ tabs })], success: true }),
    "Browser.setWindowBounds": {},
  });

  it("minimizes the agent's own window, sending the standard domain's numeric windowId", async () => {
    const cdp = cdpWith(agentWindow([tabInfo({ isGhost: true }), tabInfo({ tabId: "1002", isGhost: true })]));
    const r = await A.browserMinimize(cdp.asCdp(), { windowId: "900" });
    assert.equal(r.ok, true, r.text);
    assert.deepEqual(cdp.lastCall("Browser.setWindowBounds").params, {
      windowId: 900,
      bounds: { windowState: "minimized" },
    });
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ["one tab in it is the person's", agentWindow([tabInfo({ isGhost: true }), tabInfo({ tabId: "1002", isGhost: false })])],
    ["it has no tabs to judge by", agentWindow([])],
  ];
  for (const [name, routes] of refused) {
    it(`leaves a window alone when ${name}`, async () => {
      const cdp = cdpWith(routes);
      const r = await A.browserMinimize(cdp.asCdp(), { windowId: "900" });
      assert.equal(r.ok, false);
      assert.match(r.text, /not the agent's/);
      assert.ok(!cdp.calls.some((c) => c.method === "Browser.setWindowBounds"));
    });
  }

  it("says so when there is no such window", async () => {
    const cdp = cdpWith(agentWindow([tabInfo({ isGhost: true })]));
    const r = await A.browserMinimize(cdp.asCdp(), { windowId: "777" });
    assert.equal(r.ok, false);
    assert.match(r.text, /No window 777/);
  });
});

describe("browser-actions: odd snapshot replies", () => {
  it("no target with a usable id -> throws without sending", async () => {
    const cdp = cdpWith();
    await assert.rejects(
      () => A.takeSnapshots(cdp.asCdp(), { targets: [{ windowId: " ", tabId: "1001" }, { windowId: "900", tabId: "" }] }),
      /no usable windowId\/tabId/,
    );
    assert.equal(cdp.calls.length, 0);
  });

  it("a window answering with fewer tabs than asked fails the whole batch", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) => {
        const r = snapshotReply(p) as any;
        r.windows[0].tabs.pop();
        return r;
      },
    });
    await assert.rejects(
      () => A.takeSnapshots(cdp.asCdp(), { targets: [{ windowId: "900", tabId: "1001" }, { windowId: "900", tabId: "1002" }] }),
      /returned 1 tabs for window 900 but 2/,
    );
  });

  it("an empty tree on about:blank is a failure telling the model to navigate, and not worth retrying", async () => {
    const message = "This page is about:blank, so there is nothing on it to number. Another snapshot will say the same.";
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, { annotatedContent: '{"children":[]}', message }),
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), { targets: [{ ...TARGET }] });
    assert.equal(batch.snapshots.length, 0);
    assert.match(batch.failures[0].reason, /about:blank.*browserNavigate/);
    assert.equal(A.snapshotRetryIsPointless(batch.failures[0]), true);
  });

  it("a failed entry names the popups holding the page", async () => {
    const cdp = cdpWith({
      "Embiody.browserTakeSnapshot": (p: Record<string, unknown>) =>
        snapshotReply(p, {
          success: false,
          message: "The page did not answer",
          popups: [{ type: "beforeUnload", availableActions: [] }],
        }),
    });
    const batch = await A.takeSnapshots(cdp.asCdp(), { targets: [{ ...TARGET }] });
    assert.match(batch.failures[0].reason, /popups blocking this tab: .*beforeUnload/);
    assert.equal(batch.failures[0].raw, "The page did not answer");
  });
});

describe("browser-actions: other replies", () => {
  it("browserStopHumanControl after the agent's own handover says so", async () => {
    const r = await A.browserStopHumanControl(cdpWith().asCdp(), { ...TARGET });
    assert.equal(r.ok, true);
    assert.match(r.text, /the agent handing over/);
  });

  it("browserClosePopupBubble refused by the kernel carries its words", async () => {
    const cdp = cdpWith({
      "Embiody.browserClosePopupBubble": new Error('this prompt does not offer "allowOnce"; it offers allow, deny, dismiss'),
    });
    const r = await A.browserClosePopupBubble(cdp.asCdp(), { action: "allowOnce", ...TARGET });
    assert.equal(r.ok, false);
    assert.match(r.text, /it offers allow, deny, dismiss/);
  });

  // As browserNewWindow: with no tabId the runtime has no tab to work in.
  it("a new tab reply with no tabId is not a success", async () => {
    const cdp = cdpWith({ "Embiody.browserNewTab": () => ({ windowId: "900", loadStatus: "committed" }) });
    const r = await A.browserAddNewTab(cdp.asCdp(), { windowId: "900" });
    assert.equal(r.ok, false, r.text);
  });
});
