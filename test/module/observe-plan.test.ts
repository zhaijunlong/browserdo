import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SNAPSHOT_TABS,
  normalizeRuntimePlan,
  resolveSnapshotTabs,
  snapshotBlockedReason,
} from "../../src/runtime_types.js";
import { tabInfo, windowInfo } from "../helpers/fixtures.js";
import type { WindowInfo } from "../../src/runtime_types.js";

/**
 * Resolving the capture list: the model names tabs -> validate against this round's layout ->
 * settle which tabs are really captured.
 *
 * The model invents tabIds, names tabs already closed, names
 * twenty at once, and names the same one twice. All of it has to be handled before reaching the
 * kernel, and **the outcome has to be told to the model** — change the list silently and it will
 * make the same mistake next round.
 */

function layout(tabs: Array<{ tabId: string; url?: string; isAgentTab?: boolean }>): WindowInfo[] {
  return [
    windowInfo({
      windowId: "900",
      tabs: tabs.map((t, i) =>
        tabInfo({
          tabId: t.tabId,
          index: i,
          url: t.url ?? `https://t${t.tabId}.test/`,
          isAgentTab: t.isAgentTab ?? false,
        }),
      ),
    }),
  ] as unknown as WindowInfo[];
}

const TARGET = { windowId: "900", tabId: "1001" };

describe("resolveSnapshotTabs: handling what the model names", () => {
  it("valid named tabs -> taken as is, and not counted as a runtime choice", () => {
    const r = resolveSnapshotTabs({
      requested: ["1002"],
      layout: layout([{ tabId: "1001" }, { tabId: "1002" }]),
      target: TARGET,
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["1002"],
    );
    assert.equal(r.chosenByRuntime, false);
    assert.deepEqual(r.rejected, []);
  });

  it("several named -> all taken, in the order the model gave", () => {
    const r = resolveSnapshotTabs({
      requested: ["1003", "1001", "1002"],
      layout: layout([{ tabId: "1001" }, { tabId: "1002" }, { tabId: "1003" }]),
      target: TARGET,
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["1003", "1001", "1002"],
    );
  });

  it("a tabId that does not exist -> refused and reported, not sent to the kernel for a No Tab found", () => {
    const r = resolveSnapshotTabs({
      requested: ["1002", "invented"],
      layout: layout([{ tabId: "1001" }, { tabId: "1002" }]),
      target: TARGET,
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["1002"],
      "the valid one is still captured",
    );
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].tabId, "invented");
    assert.match(r.rejected[0].reason, /not in this round layout/);
  });

  it("none of the named exist -> fall back, and say the choice was made for it", () => {
    const r = resolveSnapshotTabs({
      requested: ["fake1", "fake2"],
      layout: layout([{ tabId: "1001" }]),
      target: TARGET,
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["1001"],
    );
    assert.equal(r.chosenByRuntime, true);
    assert.match(r.chosenReason!, /None of the tabs you named are in this round layout/);
    assert.equal(r.rejected.length, 2);
  });

  it(`naming more than ${MAX_SNAPSHOT_TABS} at once -> capture the first ${MAX_SNAPSHOT_TABS} and say how many were dropped`, () => {
    const many = Array.from({ length: MAX_SNAPSHOT_TABS + 5 }, (_, i) => ({
      tabId: `t${i}`,
    }));
    const r = resolveSnapshotTabs({
      requested: many.map((t) => t.tabId),
      layout: layout(many),
      target: { windowId: "900", tabId: "t0" },
    });
    assert.equal(r.tabs.length, MAX_SNAPSHOT_TABS);
    assert.match(r.truncatedNote!, new RegExp(String(MAX_SNAPSHOT_TABS)));
    assert.match(r.truncatedNote!, /5/, "it must say how many were dropped");
  });

  it("naming nothing -> use last round's working target, and say the choice was made for it", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: layout([{ tabId: "1001" }, { tabId: "1002" }]),
      target: TARGET,
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["1001"],
    );
    assert.equal(r.chosenByRuntime, true);
    assert.match(r.chosenReason!, /did not specify snapshot_tabs/);
  });
});

describe("resolveSnapshotTabs: the fallback order", () => {
  it("the working target still exists -> prefer it, even when another tab is an agent tab", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: layout([
        { tabId: "1001" },
        { tabId: "1002", isAgentTab: true },
      ]),
      target: TARGET,
    });
    assert.deepEqual(r.tabs.map((t) => t.tabId), ["1001"]);
  });

  it("the working target was closed -> pick an agent tab (the right path after browserCloseTab closed the working tab)", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: layout([
        { tabId: "2001", url: "https://a.test/" },
        { tabId: "2002", isAgentTab: true },
      ]),
      target: TARGET,
    });
    assert.deepEqual(r.tabs.map((t) => t.tabId), ["2002"]);
    assert.equal(r.chosenByRuntime, true);
    assert.match(r.chosenReason!, /is gone/);
  });

  it("no agent tab -> pick a non-blank page", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: layout([
        { tabId: "2001", url: "about:blank" },
        { tabId: "2002", url: "https://real.test/" },
      ]),
      target: TARGET,
    });
    assert.deepEqual(r.tabs.map((t) => t.tabId), ["2002"]);
  });

  it("all blank pages -> pick the first (the capture soft failure catches it; not this layer's business)", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: layout([
        { tabId: "2001", url: "about:blank" },
        { tabId: "2002", url: "about:blank" },
      ]),
      target: TARGET,
    });
    assert.deepEqual(r.tabs.map((t) => t.tabId), ["2001"]);
  });

  it("not one tab in the layout -> an empty list, no throw (the layer above decides what to do)", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: [],
      target: TARGET,
    });
    assert.deepEqual(r.tabs, []);
    assert.equal(r.chosenByRuntime, true);
  });

  it("finds an agent tab across windows", () => {
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: [
        windowInfo({ windowId: "900", tabs: [tabInfo({ tabId: "2001" })] }),
        windowInfo({
          windowId: "901",
          tabs: [tabInfo({ tabId: "9001", isAgentTab: true })],
        }),
      ] as unknown as WindowInfo[],
      target: TARGET,
    });
    assert.deepEqual(r.tabs.map((t) => t.tabId), ["9001"]);
    assert.equal(r.tabs[0].windowId, "901", "windowId must follow the tab");
  });
});

describe("snapshotBlockedReason: which tabs should never be sent for capture", () => {
  const tab = (over: Partial<{
    tabId: string;
    url: string;
    isAgentTab: boolean;
    isForeground: boolean;
  }> = {}) => ({
    tabId: "1001",
    url: "https://a.test/",
    isAgentTab: true,
    isForeground: false,
    ...over,
  });

  it("a background agent tab can be captured (measured 65-175ms, without stealing the foreground)", () => {
    assert.equal(snapshotBlockedReason(tab()), null);
  });

  it("not an agent tab but in the foreground can be captured", () => {
    assert.equal(
      snapshotBlockedReason(tab({ isAgentTab: false, isForeground: true })),
      null,
    );
  });

  it("neither an agent tab nor in the foreground -> not blocked", () => {
    assert.equal(snapshotBlockedReason(tab({ isAgentTab: false, isForeground: false })), null);
  });

  it("about:blank and an empty url -> blocked (a blank image says nothing the layout does not)", () => {
    for (const url of ["about:blank", "", "  ", "ABOUT:BLANK"]) {
      const why = snapshotBlockedReason(tab({ url }));
      assert.ok(why, `url=${JSON.stringify(url)} should be blocked`);
      assert.match(why!, /blank page/);
      assert.match(why!, /browserNavigate/, "the model must be told the way out");
    }
  });

  it("chrome://newtab must **not** be blocked — measurably it can be captured", () => {
    // Measured (Embiody/0.8.0.21): chrome://newtab lands on chrome://new-tab-page/ and captures
    // successfully in 131-327ms, with a 37-53KB annotated image and 6 emsn.
    // Calling it uncapturable is both untrue and a way of blocking a legitimate wish to see the new tab page.
    for (const url of [
      "chrome://newtab",
      "chrome://newtab/",
      "chrome://new-tab-page/",
    ]) {
      assert.equal(
        snapshotBlockedReason(tab({ url })),
        null,
        `${url} can be captured and must not be blocked`,
      );
    }
  });

  it("a blank page is blocked whatever its agent-tab / foreground state", () => {
    const why = snapshotBlockedReason(
      tab({ url: "about:blank", isAgentTab: false, isForeground: false }),
    );
    assert.match(why!, /blank page/, "a blank page is the more actionable one: go and navigate");
  });

  it("what the address cannot reveal is caught only by the soft failure after capturing", () => {
    // The kernel's real rule is "no text, no interactive element, and no img/canvas/svg".
    // A loading screen drawn purely in CSS (a coloured div with no text) fails the same way, and the
    // address gives no hint — this confirms we do not try to be clever and guess.
    assert.equal(
      snapshotBlockedReason(tab({ url: "https://loading.test/splash" })),
      null,
      "an address that looks ordinary should be allowed to try, and take the soft-failure path if it fails",
    );
  });
});

describe("being idle and being capturable are two different questions", () => {
  it("a new tab page: capturable, yet counts as 'nobody is using it' when picking a target", () => {
    // Picking a target asks "is it safe to take over"; the capture block asks "would capturing be wasted".
    const newtab = {
      tabId: "1001",
      url: "chrome://new-tab-page/",
      isAgentTab: false,
      isForeground: true,
    };
    assert.equal(snapshotBlockedReason(newtab), null, "capturable");

    // Picking a target: the working target is gone and neither candidate is an agent tab, so the non-idle one should win.
    const r = resolveSnapshotTabs({
      requested: undefined,
      layout: [
        windowInfo({
          windowId: "900",
          tabs: [
            tabInfo({ tabId: "2001", url: "chrome://new-tab-page/" }),
            tabInfo({ tabId: "2002", index: 1, url: "https://real.test/" }),
          ],
        }),
      ] as unknown as WindowInfo[],
      target: { windowId: "900", tabId: "already-closed" },
    });
    assert.deepEqual(
      r.tabs.map((t) => t.tabId),
      ["2002"],
      "a new tab page counts as idle and gives way to a real page when picking a target",
    );
  });
});

describe("schema normalisation of snapshot_tabs", () => {
  function planWith(snapshotTabs: unknown): Record<string, unknown> {
    return {
      task_tree_overview: "1. task([NEXT STEP])",
      current_executing_step: {
        path: "1",
        description: "previous step",
        status: "completed",
        result: "ok",
      },
      next_step_detail: {
        path: "1.1",
        description: "next step",
        status: "[NEXT STEP]",
        is_paused: false,
        action_call: { function: "browserWait", params: {} },
        ...(snapshotTabs === undefined ? {} : { snapshot_tabs: snapshotTabs }),
      },
      all_task_is_complete: false,
      complete_reason: "",
    };
  }

  it("an array is taken as is, with numbers turned into strings", () => {
    const p = normalizeRuntimePlan(planWith([1001, "1002"]));
    assert.deepEqual(p.next_step_detail.snapshot_tabs, ["1001", "1002"]);
  });

  it("a bare value from the model (not an array) is accepted too", () => {
    assert.deepEqual(
      normalizeRuntimePlan(planWith("1001")).next_step_detail.snapshot_tabs,
      ["1001"],
    );
    assert.deepEqual(
      normalizeRuntimePlan(planWith(1001)).next_step_detail.snapshot_tabs,
      ["1001"],
    );
  });

  it("naming the same tab twice is deduplicated (otherwise it buys two identical images and wastes tokens)", () => {
    assert.deepEqual(
      normalizeRuntimePlan(planWith(["1001", "1001", "1002"])).next_step_detail
        .snapshot_tabs,
      ["1001", "1002"],
    );
  });

  it("an empty array, or all empty strings -> counts as naming nothing (undefined) and falls back", () => {
    for (const v of [[], ["", "  "], ""]) {
      assert.equal(
        normalizeRuntimePlan(planWith(v)).next_step_detail.snapshot_tabs,
        undefined,
        JSON.stringify(v),
      );
    }
  });

  it("omitting the field is legal (one image by default, for backward compatibility)", () => {
    assert.equal(
      normalizeRuntimePlan(planWith(undefined)).next_step_detail.snapshot_tabs,
      undefined,
    );
  });
});
