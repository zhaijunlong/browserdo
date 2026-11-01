import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverWorkingTarget } from "../../src/embiody-browser.js";
import { FakeCdp } from "../helpers/fake-cdp.js";
import { happyRoutes, tabInfo, windowInfo } from "../helpers/fixtures.js";

function cdpWithWindows(windows: unknown[]): FakeCdp {
  return new FakeCdp({
    ...happyRoutes(),
    "Embiody.browserGetWindowInfo": () => ({ windows, success: true }),
  });
}

describe("discoverWorkingTarget: the order targets are picked in", () => {
  it("prefers a tab that is already an agent tab", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        windowId: "900",
        tabs: [
          tabInfo({ tabId: "1", url: "about:blank" }),
          tabInfo({ tabId: "2", url: "https://work.test/", isGhost: true }),
        ],
      }),
    ]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.tabId, "2", "an agent tab ranks highest, even with a blank page before it");
    assert.equal(t.url, "https://work.test/");
  });

  it("with no agent tab, picks the blank page (the one the exe opens; nobody is using it)", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        windowId: "900",
        tabs: [
          tabInfo({ tabId: "1", url: "https://a-page-someone-is-reading.test/" }),
          tabInfo({ tabId: "2", url: "about:blank" }),
        ],
      }),
    ]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.tabId, "2");
  });

  it("chrome://newtab counts as idle too (safe to take over, though it can be captured)", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        tabs: [
          tabInfo({ tabId: "1", url: "https://busy.test/" }),
          tabInfo({ tabId: "2", url: "chrome://newtab/" }),
        ],
      }),
    ]);
    assert.equal((await discoverWorkingTarget(cdp.asCdp())).tabId, "2");
  });

  it("an empty url counts as a blank page", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        tabs: [
          tabInfo({ tabId: "1", url: "https://busy.test/" }),
          tabInfo({ tabId: "2", url: "" }),
        ],
      }),
    ]);
    assert.equal((await discoverWorkingTarget(cdp.asCdp())).tabId, "2");
  });

  it("with neither an agent tab nor a blank page, falls back to the first tab", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        windowId: "900",
        tabs: [tabInfo({ tabId: "1", url: "https://a.test/" })],
      }),
      windowInfo({
        windowId: "901",
        tabs: [tabInfo({ tabId: "2", url: "https://b.test/" })],
      }),
    ]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.windowId, "900");
    assert.equal(t.tabId, "1");
  });

  it("finds an agent tab across windows", async () => {
    const cdp = cdpWithWindows([
      windowInfo({
        windowId: "900",
        tabs: [tabInfo({ tabId: "1", url: "https://a.test/" })],
      }),
      windowInfo({
        windowId: "901",
        hasGhostTab: true,
        tabs: [tabInfo({ tabId: "9", url: "https://work.test/", isGhost: true })],
      }),
    ]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.windowId, "901");
    assert.equal(t.tabId, "9");
  });
});

describe("discoverWorkingTarget: shapes and errors", () => {
  it("tabId is a real id, not [object Object] (the protocol made tabs an array of objects)", async () => {
    const cdp = cdpWithWindows([windowInfo()]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.tabId, "1001");
    assert.doesNotMatch(t.tabId, /object Object/);
  });

  it("brings the url along, so the runtime can tell an empty page (saving a capture bound to hold nothing)", async () => {
    const cdp = cdpWithWindows([
      windowInfo({ tabs: [tabInfo({ tabId: "1", url: "about:blank" })] }),
    ]);
    assert.equal((await discoverWorkingTarget(cdp.asCdp())).url, "about:blank");
  });

  it("throws a readable error when there is no window at all", async () => {
    const cdp = cdpWithWindows([]);
    await assert.rejects(
      () => discoverWorkingTarget(cdp.asCdp()),
      /returned no usable window or tab/,
    );
  });

  it("throws too when a window exists but has no tabs", async () => {
    const cdp = cdpWithWindows([windowInfo({ tabs: [] })]);
    await assert.rejects(
      () => discoverWorkingTarget(cdp.asCdp()),
      /returned no usable window or tab/,
    );
  });

  it("entries with an empty windowId/tabId are skipped and never chosen", async () => {
    const cdp = cdpWithWindows([
      windowInfo({ windowId: "", tabs: [tabInfo({ tabId: "1" })] }),
      windowInfo({ windowId: "902", tabs: [tabInfo({ tabId: "" })] }),
      windowInfo({ windowId: "903", tabs: [tabInfo({ tabId: "7" })] }),
    ]);
    const t = await discoverWorkingTarget(cdp.asCdp());
    assert.equal(t.windowId, "903");
    assert.equal(t.tabId, "7");
  });

  it("uses the singular command browserGetWindowInfo", async () => {
    const cdp = cdpWithWindows([windowInfo()]);
    await discoverWorkingTarget(cdp.asCdp());
    assert.deepEqual(cdp.methodSequence(), ["Embiody.browserGetWindowInfo"]);
  });
});
