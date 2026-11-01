import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
// This line must come before every src/ import: it redirects snapshot output to a temp directory, so tests do not dirty the working directory.
import "../helpers/tmp-snapshot-dir.js";
import * as A from "../../src/browser-actions.js";
import {
  BrowserRuntimeExecutor,
  EMSN_WIRE_PARAMS,
} from "../../src/runtime_executor.js";
import {
  RUNTIME_ANSWERED_ACTIONS,
  RuntimeActionNameSchema,
} from "../../src/runtime_types.js";
import { discoverWorkingTarget } from "../../src/embiody-browser.js";
import { FakeCdp } from "../helpers/fake-cdp.js";
import { happyRoutes, TARGET } from "../helpers/fixtures.js";
import {
  findPdl,
  names,
  parsePdl,
  requiredNames,
  type Pdl,
} from "../helpers/pdl.js";

/**
 * The protocol contract tests — the most important group in this suite.
 *
 * How they work: every action is really run (against a fake CDP), the command name and payload
 * keys it emits are recorded, and each is checked against embiody_protocol.pdl. Not by grepping
 * the source — grepping misses payloads assembled at run time (browserScroll, for instance,
 * decides by value whether to send deltaX).
 *
 * What this group is worth: after the browser changes the protocol, one npm test tells us
 * which command name, which parameter or which reply field no longer lines up — with no new build
 * installed and no model run. The September 2026 protocol revision (browserGetWindowInfos becoming singular, tabs
 * going from string[] to TabInfo[], navigation replies having no success, returnAnnotateContent
 * one d short) should all have been caught here.
 */

const pdlPath = findPdl();

describe("protocol contract (checked against embiody_protocol.pdl)", { skip: pdlPath ? false : "embiody_protocol.pdl not found (point EMBIODY_PDL_PATH at it)" }, () => {
  let pdl: Pdl;

  before(() => {
    pdl = parsePdl(pdlPath!);
    assert.ok(pdl.commands.size > 10, `the pdl parsed oddly: only ${pdl.commands.size} commands`);
  });

  /**
   * Run every action and collect (command name -> the set of payload keys that go on the wire).
   * Some actions take different branches by parameter, so one command may be called several times;
   * the key sets are unioned, and each call's own set is also kept for the required-parameter check.
   */
  async function exerciseEveryAction(): Promise<FakeCdp> {
    const cdp = new FakeCdp(happyRoutes());
    const c = cdp.asCdp();

    await A.browserGetWindowInfo(c);
    await A.browserNewWindow(c, { url: "https://a.test/", hideWindow: false, incognito: false });
    await A.browserNavigate(c, { url: "https://a.test/", ...TARGET, waitUntil: "title", timeoutMs: 5000 });
    await A.browserNavigate(c, { url: "https://a.test/", ...TARGET });
    await A.browserAddNewTab(c, { windowId: TARGET.windowId, url: "https://a.test/", foreground: false, waitUntil: "load", timeoutMs: 5000 });
    await A.browserAddNewTab(c, { windowId: TARGET.windowId });
    await A.browserGoBack(c, { ...TARGET, waitUntil: "commit", timeoutMs: 1000 });
    await A.browserGoForward(c, { ...TARGET });
    await A.browserReload(c, { ...TARGET, bypassCache: true, resubmitForm: true, waitUntil: "firstPaint", timeoutMs: 1000 });
    await A.browserStopLoading(c, { ...TARGET });
    await A.browserSetAudioMuted(c, { muted: true, ...TARGET });
    await A.browserCloseTab(c, { ...TARGET });
    await A.browserCloseWindow(c, { windowId: TARGET.windowId });
    await A.browserSelectTab(c, { ...TARGET });
    await A.browserShow(c, { windowId: TARGET.windowId });
    await A.browserShow(c, { windowId: TARGET.windowId, toState: "Maximized" });
    await A.browserClosePopupBubble(c, { action: "dismiss", ...TARGET });
    await A.browserStartHumanControl(c, { ...TARGET, showWindow: true });
    await A.browserStopHumanControl(c, { ...TARGET });
    // click has two branches: emsn and coordinates are mutually exclusive
    await A.browserClick(c, { emsn: 7, button: "left", clickCount: 1, ...TARGET, snapshotId: "snap-1" });
    await A.browserClick(c, { x: 10, y: 20, ...TARGET, snapshotId: "snap-1" });
    await A.browserInputText(c, { text: "hi", clearText: true, pressEnter: true, emsn: 7, ...TARGET, snapshotId: "snap-1" });
    // typing at a place: one call per way of naming it
    await A.browserInputText(c, { text: "hi", emsn: 7, before: "a", occurrence: 2, ...TARGET, snapshotId: "snap-1" });
    await A.browserInputText(c, { text: "hi", emsn: 7, after: "a", ...TARGET, snapshotId: "snap-1" });
    await A.browserInputText(c, { text: "", emsn: 7, replace: "a", ...TARGET, snapshotId: "snap-1" });
    await A.browserInputText(c, { text: "hi", emsn: 7, at: "end", ...TARGET, snapshotId: "snap-1" });
    await A.browserPressKey(c, { keys: [{ key: "End" }, { key: "ArrowLeft", repeatCount: 2 }], repeatDelayMs: 50, emsn: 7, ...TARGET, snapshotId: "snap-1" });
    // select text: one call per way of saying what to select
    await A.browserSelectEditableText(c, { emsn: 7, select: "hi", occurrence: 2, ...TARGET, snapshotId: "snap-1" });
    await A.browserSelectEditableText(c, { emsn: 7, from: "a", to: "b", toOccurrence: 1, ...TARGET, snapshotId: "snap-1" });
    await A.browserSelectEditableText(c, { emsn: 7, all: true, ...TARGET, snapshotId: "snap-1" });
    // move has two branches, as click does
    await A.browserMove(c, { emsn: 7, ...TARGET, snapshotId: "snap-1" });
    await A.browserMove(c, { x: 10, y: 20, ...TARGET, snapshotId: "snap-1" });
    // drag has one branch per way of naming the destination
    await A.browserDrag(c, { emsn: 7, toEmsn: 9, ...TARGET, snapshotId: "snap-1" });
    await A.browserDrag(c, { emsn: 7, toEmsn: 9, toX: 30, toY: 40, ...TARGET, snapshotId: "snap-1" });
    await A.browserDrag(c, { emsn: 7, toX: 30, toY: 40, button: "left", holdMs: 200, settleMs: 100, ...TARGET, snapshotId: "snap-1" });
    await A.browserDrag(c, { x: 10, y: 20, dx: 120, dy: 0, ...TARGET, snapshotId: "snap-1" });
    // scroll: how far, where to, and aimed at an element or a point first
    await A.browserScroll(c, { deltaY: 400, ...TARGET });
    await A.browserScroll(c, { deltaX: 100, deltaY: 0, repeatCount: 2, repeatDelayMs: 50, speed: 150, ...TARGET });
    await A.browserScroll(c, { toX: 0, toY: 999999, onEmsn: 7, ...TARGET, snapshotId: "snap-1" });
    await A.browserScroll(c, { deltaY: 300, onEmsn: 7, onX: 5, onY: 5, ...TARGET, snapshotId: "snap-1" });
    await A.takeSnapshot(c, { ...TARGET });
    await A.takeSnapshot(c, { ...TARGET, long: true });
    await A.takeSnapshots(c, {
      targets: [
        { windowId: "900", tabId: "1001" },
        { windowId: "900", tabId: "1002" },
      ],
    });
    // browser_read_pages: the whole page, with its corners, and the links
    await A.takeSnapshots(c, { targets: [{ ...TARGET, wholePage: true, href: true, image: false }] });

    return cdp;
  }

  it("every command we send exists in the pdl", async () => {
    const cdp = await exerciseEveryAction();
    const missing = [...new Set(cdp.calls.map((c) => c.method))]
      .filter((m) => m.startsWith("Embiody."))
      .filter((m) => !pdl.commands.has(m.slice("Embiody.".length)));
    assert.deepEqual(missing, [], `these commands are not in the pdl: ${missing.join(", ")}`);
  });

  it("we no longer call any command marked unimplemented or removed", async () => {
    const cdp = await exerciseEveryAction();
    // These commands are still in the pdl (or once were), but the kernel turned them into hard errors or deleted them.
    const forbidden = [
      "freezeRender",
      "unfreezeRender",
      "manageCookies",
      "waitForElement",
      "provideAuthResponse",
      "getComputedLabel",
      "getSemanticRole",
      "browserStartup",
      "browserGetWindowInfos",
    ];
    const used = cdp.calls
      .map((c) => c.method.replace(/^Embiody\./, ""))
      .filter((m) => forbidden.includes(m));
    assert.deepEqual([...new Set(used)], [], `still calling retired commands: ${used.join(", ")}`);
  });

  it("every payload key on the wire is a parameter the pdl declares", async () => {
    const cdp = await exerciseEveryAction();
    const problems: string[] = [];
    for (const call of cdp.calls) {
      if (!call.method.startsWith("Embiody.")) continue;
      const spec = pdl.commands.get(call.method.slice("Embiody.".length));
      if (!spec) continue;
      const allowed = new Set(names(spec.parameters));
      for (const key of call.wireKeys) {
        if (!allowed.has(key)) {
          problems.push(
            `${call.method}.${key} (the pdl allows: ${[...allowed].join(", ") || "no parameters"})`,
          );
        }
      }
    }
    assert.deepEqual([...new Set(problems)], [], problems.join("\n"));
  });

  it("every non-optional parameter in the pdl really is sent on every call", async () => {
    const cdp = await exerciseEveryAction();
    const problems: string[] = [];
    for (const call of cdp.calls) {
      if (!call.method.startsWith("Embiody.")) continue;
      const spec = pdl.commands.get(call.method.slice("Embiody.".length));
      if (!spec) continue;
      const sent = new Set(call.wireKeys);
      for (const req of requiredNames(spec.parameters)) {
        if (!sent.has(req)) {
          // A key whose value is undefined is dropped by JSON.stringify, which is the same as not
          // sending it, and the kernel answers InvalidParams.
          problems.push(
            `${call.method} is missing the required parameter ${req} (actually sent: ${call.wireKeys.join(", ") || "nothing"})`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("every reply field we read is a return value the pdl declares", () => {
    // What we read is registered by hand. Deliberately not inferred: reading a reply is property
    // access scattered through the code, inference would miss some, and the one it missed would be
    // precisely the field that silently turns undefined.
    const reads: Record<string, string[]> = {
      browserGetWindowInfo: ["windows", "success"],
      browserNewWindow: ["windowId", "tabId", "success"],
      browserNavigate: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserNewTab: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserGoBack: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserGoForward: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserReload: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserStopLoading: ["wasLoading"],
      browserSetAudioMuted: ["muted", "success"],
      browserCloseTab: ["remainingTabsCount", "success"],
      browserCloseWindow: ["success"],
      browserClick: ["success", "message"],
      browserInputText: ["success", "message", "editedText"],
      browserPressKey: ["success", "message"],
      browserSelectEditableText: ["success", "message", "selectedText"],
      browserScroll: ["success", "message"],
      browserMove: ["success", "x", "y", "message"],
      browserDrag: ["success", "x", "y", "toX", "toY", "message"],
      browserClosePopupBubble: ["closed", "types", "appliedAction"],
      browserStartHumanControl: ["success"],
      browserStopHumanControl: ["success", "reason"],
      // Only these two are at the top level; the rest lives in SnapshotWindowResult /
      // SnapshotTabResult, covered by the nested cases below.
      browserTakeSnapshot: ["windows", "browserPopups"],
    };
    const problems: string[] = [];
    for (const [cmd, fields] of Object.entries(reads)) {
      const spec = pdl.commands.get(cmd);
      if (!spec) {
        problems.push(`the pdl has no command ${cmd}`);
        continue;
      }
      const declared = new Set(names(spec.returns));
      for (const f of fields) {
        if (!declared.has(f)) {
          problems.push(
            `${cmd}'s reply has no ${f} (it has: ${[...declared].join(", ")})`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("every return field the pdl declares is either read by us or explicitly registered as knowingly ignored", () => {
    // This covers the old blind spot: the contract tests verified "the fields we read exist" but not
    // "the protocol added a field and we missed it". The popups added in September 2026 went missing for a round that way.
    const readByUs: Record<string, string[]> = {
      browserGetWindowInfo: ["windows", "success"],
      browserNewWindow: ["windowId", "tabId", "success"],
      browserNavigate: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserNewTab: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserGoBack: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserGoForward: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserReload: ["windowId", "tabId", "title", "url", "loadStatus"],
      browserStopLoading: ["wasLoading"],
      browserSetAudioMuted: ["muted", "success"],
      browserCloseTab: ["remainingTabsCount", "success"],
      browserCloseWindow: ["success"],
      browserClick: ["success", "message"],
      browserInputText: ["success", "message", "editedText"],
      browserPressKey: ["success", "message"],
      browserSelectEditableText: ["success", "message", "selectedText"],
      browserScroll: ["success", "message"],
      browserMove: ["success", "x", "y", "message"],
      browserDrag: ["success", "x", "y", "toX", "toY", "message"],
      browserClosePopupBubble: ["closed", "types", "appliedAction"],
      browserStartHumanControl: ["success"],
      browserStopHumanControl: ["success", "reason"],
      // Only these two are at the top level; the rest lives in SnapshotWindowResult /
      // SnapshotTabResult, covered by the nested cases below.
      browserTakeSnapshot: ["windows", "browserPopups"],
      browserShow: ["success"],
      browserSelectTab: ["success"],
    };
    /** Fields we know exist and deliberately do not read, with the reason. */
    const deliberatelyIgnored: Record<string, string[]> = {
      browserHide: ["success"],
      browserIsHidden: ["isHidden"],
    };

    const problems: string[] = [];
    for (const [name, spec] of pdl.commands) {
      // We never call the unimplemented or removed commands, so they need no registration.
      if (
        [
          "freezeRender",
          "unfreezeRender",
          "manageCookies",
          "waitForElement",
          "provideAuthResponse",
        ].includes(name)
      ) {
        continue;
      }
      const known = new Set([
        ...(readByUs[name] ?? []),
        ...(deliberatelyIgnored[name] ?? []),
      ]);
      if (!known.size) {
        problems.push(`command ${name} has no registered return fields at all`);
        continue;
      }
      for (const f of names(spec.returns)) {
        if (!known.has(f)) {
          problems.push(
            `${name}.${f} is a return field the pdl declares, but we neither read it nor registered it as knowingly ignored`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("PopupInfo's fields match the pdl", () => {
    const declared = pdl.types.get("PopupInfo");
    assert.ok(declared, "the pdl should hold type PopupInfo");
    assert.deepEqual(
      [...names(declared!)].sort(),
      ["availableActions", "message", "title", "type"],
      "PopupInfo's fields do not match the pdl (pdl: " + names(declared!).join(", ") + ")",
    );
  });

  it("navigation replies really do carry no success — which is why only loadStatus can be read", () => {
    for (const cmd of [
      "browserNavigate",
      "browserGoBack",
      "browserGoForward",
      "browserReload",
      "browserNewTab",
    ]) {
      const spec = pdl.commands.get(cmd)!;
      const declared = names(spec.returns);
      assert.ok(
        !declared.includes("success"),
        `${cmd} now carries success — revisit the interpretation logic instead of reading loadStatus alone`,
      );
      assert.ok(
        declared.includes("loadStatus") && declared.includes("url"),
        `${cmd}'s reply is missing loadStatus/url`,
      );
    }
  });

  it("TabInfo / WindowInfo fields match the pdl exactly (one more or one fewer must be noticed)", () => {
    const expected: Record<string, string[]> = {
      TabInfo: [
        "tabId", "index", "title", "url", "isForeground", "isGhost",
        "canGoBack", "canGoForward", "isMuted", "isAudible",
      ],
      WindowInfo: [
        "windowId", "index", "title", "isHidden", "windowState",
        "hasGhostTab", "tabs",
      ],
    };
    for (const [type, fields] of Object.entries(expected)) {
      const declared = pdl.types.get(type);
      assert.ok(declared, `the pdl has no type ${type}`);
      assert.deepEqual(
        [...names(declared!)].sort(),
        [...fields].sort(),
        `${type}'s fields do not match the pdl (pdl: ${names(declared!).join(", ")})`,
      );
    }
  });

  it("waitUntil values are milestones the pdl describes, and do not mix in loadStatus spellings", async () => {
    const cdp = new FakeCdp(happyRoutes());
    // The request side uses commit/title/firstPaint/load; the reply side uses
    // committed/titled/firstPaint/loaded. Mixing them is an easy mistake, so the reply-side
    // spellings are fed in and expected to be dropped in favour of the default.
    for (const bad of ["committed", "titled", "loaded", "nonsense", ""]) {
      await A.browserNavigate(cdp.asCdp(), {
        url: "https://a.test/",
        ...TARGET,
        waitUntil: bad,
      });
      assert.ok(
        !cdp.lastCall("Embiody.browserNavigate").wireKeys.includes("waitUntil"),
        `waitUntil="${bad}" should never be sent`,
      );
    }
    for (const good of ["commit", "title", "firstPaint", "load"]) {
      await A.browserNavigate(cdp.asCdp(), {
        url: "https://a.test/",
        ...TARGET,
        waitUntil: good,
      });
      assert.equal(
        cdp.lastCall("Embiody.browserNavigate").params.waitUntil,
        good,
      );
    }
  });

  it("every action in the model's action table routes to a command that really exists", async () => {
    // Actions the runtime answers itself (queryHistoryPage) never reach the browser and are excluded.
    const actionNames = RuntimeActionNameSchema.options.filter(
      (a) => !RUNTIME_ANSWERED_ACTIONS.has(a),
    );
    const problems: string[] = [];
    for (const action of actionNames) {
      const cdp = new FakeCdp(happyRoutes());
      const executor = new BrowserRuntimeExecutor(cdp.asCdp());
      // Supply every parameter any action might want; the unused ones are ignored.
      const params: Record<string, unknown> = {
        url: "https://a.test/",
        emsn: 7,
        // browserDrag refuses without a destination, so the bag carries one.
        toEmsn: 9,
        text: "hi",
        deltaY: 400,
        muted: true,
        durationMs: 100,
      };
      try {
        await executor.execute(
          { function: action, params },
          TARGET,
          undefined,
          // click/inputText must carry the id of this batch of numbers
          new Map([[TARGET.tabId, "snap-1"]]),
        );
      } catch (e) {
        problems.push(`${action}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // browserWait never touches CDP; every other action must land on an Embiody command
      if (action !== "browserWait" && cdp.calls.length === 0) {
        problems.push(`${action}: sent no CDP command at all`);
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("discoverWorkingTarget relies only on WindowInfo/TabInfo fields the pdl declares", async () => {
    const cdp = new FakeCdp(happyRoutes());
    const target = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(cdp.lastCall("Embiody.browserGetWindowInfo").method, "Embiody.browserGetWindowInfo");
    assert.equal(target.windowId, "900");
    assert.equal(target.tabId, "1001");
  });

  // ---- Nested objects: browserTakeSnapshot's trees and browserPressKey's keys[] ----
  //
  // The cases above look only at the **top level**. browserTakeSnapshot's top level holds only
  // targets / windows / browserPopups; the fields that get renamed (snapshotData->image,
  // annotatedImageData->annotatedImage) live in nested types, and a rename there is what makes
  // a client read undefined silently. The kernel also refuses an unknown field in a nested
  // object it is sent.

  it("every level of the targets tree we send uses keys the pdl declares", async () => {
    const cdp = await exerciseEveryAction();
    const problems: string[] = [];
    const allowed = (typeName: string) => {
      const t = pdl.types.get(typeName);
      assert.ok(t, `the pdl has no type ${typeName}`);
      return new Set(names(t!));
    };
    const targetKeys = allowed("SnapshotTarget");
    const tabKeys = allowed("SnapshotTabTarget");
    const pointKeys = allowed("SnapshotPoint");
    let corners = 0;

    for (const call of cdp.callsTo("Embiody.browserTakeSnapshot")) {
      const targets = (call.params as { targets?: unknown[] }).targets;
      assert.ok(Array.isArray(targets), "browserTakeSnapshot sent no targets array");
      for (const t of targets as Array<Record<string, unknown>>) {
        for (const k of Object.keys(t)) {
          if (!targetKeys.has(k)) problems.push(`SnapshotTarget.${k} is not in the pdl`);
        }
        for (const tab of (t.tabs ?? []) as Array<Record<string, unknown>>) {
          for (const k of Object.keys(tab)) {
            if (!tabKeys.has(k)) problems.push(`SnapshotTabTarget.${k} is not in the pdl`);
          }
          for (const corner of ["longTopLeft", "longBottomRight"]) {
            const point = tab[corner] as Record<string, unknown> | undefined;
            if (!point) continue;
            corners++;
            for (const k of Object.keys(point)) {
              if (!pointKeys.has(k)) problems.push(`SnapshotTabTarget.${corner}.${k} is not in the pdl`);
            }
          }
        }
      }
    }
    assert.ok(corners > 0, "no whole-page snapshot was exercised, so its corners went unchecked");
    assert.deepEqual([...new Set(problems)], [], problems.join("\n"));
  });

  it("browserPressKey's keys[] use only KeyPress fields", async () => {
    const cdp = await exerciseEveryAction();
    const t = pdl.types.get("KeyPress");
    assert.ok(t, "the pdl has no type KeyPress");
    const allowed = new Set(names(t!));
    const problems: string[] = [];
    for (const call of cdp.callsTo("Embiody.browserPressKey")) {
      for (const k of (call.params as { keys: Array<Record<string, unknown>> }).keys) {
        for (const f of Object.keys(k)) if (!allowed.has(f)) problems.push(`KeyPress.${f} is not in the pdl`);
      }
    }
    assert.deepEqual([...new Set(problems)], [], problems.join("\n"));
  });

  it("every nested field we read from a snapshot reply is declared in the pdl", () => {
    // As above, registered by hand. An unregistered field is the one that silently turns undefined.
    const nestedReads: Record<string, string[]> = {
      SnapshotWindowResult: ["windowId", "popups", "tabs"],
      SnapshotTabResult: [
        "tabId",
        "success",
        "snapshotId",
        "annotatedImage",
        "annotatedContent",
        "popups",
        "elapsedMs",
        "message",
        "url",
        "pageType",
        "image",
      ],
      PopupInfo: ["type", "message", "title", "availableActions"],
    };
    const problems: string[] = [];
    for (const [typeName, fields] of Object.entries(nestedReads)) {
      const t = pdl.types.get(typeName);
      if (!t) {
        problems.push(`the pdl has no type ${typeName}`);
        continue;
      }
      const declared = new Set(names(t));
      for (const f of fields) {
        if (!declared.has(f)) {
          problems.push(
            `${typeName}.${f} is not in the pdl (it has: ${[...declared].join(", ")})`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("every emsn parameter the pdl declares is gated by EMSN_WIRE_PARAMS", () => {
    // The gate refuses a number we never showed the model. A command (or a parameter such as
    // toEmsn / onEmsn) that takes a number and is missing there skips the gate entirely, and the
    // kernel will happily act on an invented number — the failure this whole guard exists for.
    const missing: string[] = [];
    for (const [name, spec] of pdl.commands) {
      for (const param of names(spec.parameters).filter((n) => /^(emsn|[a-z]+Emsn)$/.test(n))) {
        if (!EMSN_WIRE_PARAMS[name]?.includes(param)) missing.push(`${name}.${param}`);
      }
    }
    assert.deepEqual(missing, [], `the pdl takes a number here but the executor's gate does not know it: ${missing.join(", ")}`);
  });

  it("a field added to SnapshotTabResult that we do not read must be explicitly registered", () => {
    // This covers the opposite direction: the protocol appends fields to this type (the change notes
    // say the window level will keep gaining more) and we do not know. The popups added in September 2026 went missing
    // for a round that way.
    const readByUs = new Set([
      "tabId",
      "success",
      "snapshotId",
      "annotatedImage",
      "annotatedContent",
      "popups",
      "elapsedMs",
      "message",
      "url",
      "pageType",
      "image",
    ]);
    /** Known to exist and deliberately not read, with the reason. */
    const ignored: Record<string, string> = {
      windowId: "we match the requested targets position by position and use the windowId we sent",
    };
    const t = pdl.types.get("SnapshotTabResult");
    assert.ok(t, "the pdl has no SnapshotTabResult");
    const unaccounted = names(t!).filter(
      (f) => !readByUs.has(f) && !(f in ignored),
    );
    assert.deepEqual(
      unaccounted,
      [],
      `SnapshotTabResult has fields we never registered: ${unaccounted.join(", ")} — read them, or write down why not`,
    );
  });

});
