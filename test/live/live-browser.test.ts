import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import * as A from "../../src/browser-actions.js";
import { CdpClient } from "../../src/cdp-client.js";
import {
  assertProtocolSupported,
  discoverWorkingTarget,
  ensureEmbiodyBrowser,
  readBrowserVersion,
} from "../../src/embiody-browser.js";
import { loadRuntimeConfigFile } from "../../src/runtime_config.js";
import { snapshotBlockedReason } from "../../src/runtime_types.js";

/**
 * Live tests: they need a real Embiody browser and the whole group is skipped by default.
 *
 *   enable:        EMBIODY_LIVE_TEST=1 npm test
 *   pick a build:  EMBIODY_EXE_PATH=C:/path/to/embiody.exe
 *   or a config:   EMBIODY_TEST_CONFIG=path/to/browserdo.config.yaml
 *
 * A custom exePath automatically lands on the profile derived from that exe path and never
 * competes with the installed build for DevToolsActivePort, so a live test cannot connect to the
 * wrong build by mistake.
 *
 * This group opens tabs, navigates, mutes and hands over control — all inside tabs it opened
 * itself and closes at the end. Tabs that already existed are left alone.
 */

const live = process.env.EMBIODY_LIVE_TEST === "1";
const skip = live ? false : "needs a real browser: set EMBIODY_LIVE_TEST=1 (and EMBIODY_EXE_PATH if required)";

describe("live: the current protocol", { skip }, () => {
  let cdp: CdpClient;
  let port: number;
  let base: { windowId: string; tabId: string };
  let tab = "";

  before(async () => {
    if (process.env.EMBIODY_TEST_CONFIG) {
      loadRuntimeConfigFile(process.env.EMBIODY_TEST_CONFIG);
    }
    port = await ensureEmbiodyBrowser();
    cdp = new CdpClient("127.0.0.1", port);
    await cdp.connect();
    console.log(`  browser: ${await readBrowserVersion(port)}  port ${port}`);
    await assertProtocolSupported(cdp, port);
    base = await discoverWorkingTarget(cdp);
  });

  after(async () => {
    if (tab) {
      // A tab whose control was handed over must be taken back first, or closeTab is refused.
      await A.browserStopHumanControl(cdp, { ...base, tabId: tab }).catch(() => {});
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: tab }).catch(
        () => {},
      );
    }
    cdp?.disconnect();
  });

  it("assertProtocolSupported passes on a new build", async () => {
    // Written as doesNotReject on purpose: relying on "nothing threw" reads like a missing assertion.
    await assert.doesNotReject(() => assertProtocolSupported(cdp, port));
  });

  it("browserGetWindowInfo returns an array of TabInfo objects with every field", async () => {
    const windows = await A.browserGetWindowInfo(cdp);
    assert.ok(windows.length > 0);
    const t = windows[0].tabs[0];
    assert.equal(typeof t, "object");
    assert.equal(typeof t.tabId, "string");
    assert.ok(t.tabId.length > 0, "tabId must not be an empty string or [object Object]");
    for (const key of [
      "index", "title", "url", "isForeground", "isAgentTab",
      "canGoBack", "canGoForward", "isMuted", "isAudible",
    ] as const) {
      assert.ok(key in t, `TabInfo is missing ${key}`);
    }
    for (const key of [
      "index", "title", "isHidden", "windowState", "hasAgentTab", "tabs",
    ] as const) {
      assert.ok(key in windows[0], `WindowInfo is missing ${key}`);
    }
    assert.match(windows[0].windowState, /minimized|fullscreen|maximized|normal/);
  });

  it("browserShow(toState=Maximized) maximises the window in one hop", async () => {
    await A.browserShow(cdp, { windowId: base.windowId, toState: "Maximized" });
    const w = (await A.browserGetWindowInfo(cdp)).find(
      (x) => x.windowId === base.windowId,
    );
    assert.equal(w?.windowState, "maximized");
  });

  it("browserNewTab opens in the background by default and is an agent tab from birth", async () => {
    const r = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: "https://example.com/",
      waitUntil: "title",
    });
    assert.ok(r.ok, r.text);
    tab = String(r.data!.tabId);
    assert.ok(tab.length > 0);

    const info = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, tab);
    assert.equal(info?.isForeground, false, "it should open in the background by default");
    assert.equal(info?.isAgentTab, true, "a new tab should be the agent's from the very start");
  });

  it("closing a tab does not drop the connection (it is to the browser, not to a page)", async () => {
    // Open the tab before connecting: a page-level client would have attached to the newest page.
    const r = await A.browserAddNewTab(cdp, { windowId: base.windowId, waitUntil: "commit" });
    assert.ok(r.ok, r.text);
    const doomed = String(r.data!.tabId);

    const own = new CdpClient("127.0.0.1", port);
    await own.connect();
    try {
      const closed = await A.browserCloseTab(own, { windowId: base.windowId, tabId: doomed });
      assert.ok(closed.ok, closed.text);
      assert.ok(own.isConnected, "the connection went down with the tab");
      const layout = await A.browserGetWindowInfo(own);
      assert.ok(!layout.some((w) => w.tabs.some((t) => t.tabId === doomed)));
    } finally {
      own.disconnect();
    }
  });

  it("browserNavigate replies with loadStatus and the real landing url", async () => {
    const r = await A.browserNavigate(cdp, {
      url: "https://example.org/",
      windowId: base.windowId,
      tabId: tab,
      waitUntil: "title",
    });
    assert.ok(r.ok, r.text);
    assert.match(String(r.data!.loadStatus), /committed|titled|firstPaint|loaded/);
    assert.equal(r.data!.url, "https://example.org/");
  });

  it("TabInfo.canGoBack agrees with what browserGoBack actually does", async () => {
    const before = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, tab);
    assert.equal(before?.canGoBack, true, "after navigating twice it should be able to go back");
    const r = await A.browserGoBack(cdp, { windowId: base.windowId, tabId: tab });
    assert.ok(r.ok, r.text);
    assert.equal(r.data!.url, "https://example.com/");
  });

  it("browserGoForward likewise", async () => {
    const before = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, tab);
    assert.equal(before?.canGoForward, true);
    const r = await A.browserGoForward(cdp, { windowId: base.windowId, tabId: tab });
    assert.ok(r.ok, r.text);
    assert.equal(r.data!.url, "https://example.org/");
  });

  it("with canGoBack=false, browserGoBack really is a hard error (not a false success)", async () => {
    // Verified on a freshly opened tab with no history.
    const fresh = await A.browserAddNewTab(cdp, { windowId: base.windowId });
    assert.ok(fresh.ok, fresh.text);
    const freshTab = String(fresh.data!.tabId);
    try {
      const info = A.findTab(
        await A.browserGetWindowInfo(cdp),
        base.windowId,
        freshTab,
      );
      assert.equal(info?.canGoBack, false);
      const r = await A.browserGoBack(cdp, {
        windowId: base.windowId,
        tabId: freshTab,
      });
      assert.equal(r.ok, false, "it should fail rather than return a success the caller has to doubt");
      assert.match(r.text, /no history entry to move to/);
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: freshTab });
    }
  });

  it("browserReload reloads successfully", async () => {
    const r = await A.browserReload(cdp, { windowId: base.windowId, tabId: tab });
    assert.ok(r.ok, r.text);
  });

  it("browserStopLoading replies with wasLoading (and no success field)", async () => {
    const r = await A.browserStopLoading(cdp, { windowId: base.windowId, tabId: tab });
    assert.ok(r.ok, r.text);
    assert.equal(typeof r.data!.wasLoading, "boolean");
  });

  it("the effect of browserSetAudioMuted can be read back from TabInfo.isMuted", async () => {
    const on = await A.browserSetAudioMuted(cdp, {
      muted: true,
      windowId: base.windowId,
      tabId: tab,
    });
    assert.ok(on.ok, on.text);
    assert.equal(on.data!.muted, true);
    assert.equal(
      A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, tab)?.isMuted,
      true,
    );

    const off = await A.browserSetAudioMuted(cdp, {
      muted: false,
      windowId: base.windowId,
      tabId: tab,
    });
    assert.ok(off.ok, off.text);
    assert.equal(off.data!.muted, false);
  });

  it("browserClosePopupBubble succeeds even with no popup present", async () => {
    const r = await A.browserClosePopupBubble(cdp, {
      windowId: base.windowId,
      tabId: tab,
    });
    // Only asserts that the command answers normally. Whether a popup happens to be open is not
    // under the test's control — asserting closed===false goes red at random (observed once).
    assert.ok(r.ok, r.text);
    assert.equal(typeof r.data!.closed, "boolean");
  });

  it("takeSnapshot really returns annotatedContent (the field name with the extra d), with no need to bring the tab forward", async () => {
    // browserSelectTab is deliberately **not** called: a background tab should be capturable as is.
    const before = A.findTab(
      await A.browserGetWindowInfo(cdp),
      base.windowId,
      tab,
    );
    const snap = await A.takeSnapshot(cdp, {
      windowId: base.windowId,
      tabId: tab,
      url: "https://example.org/",
    });
    const after = A.findTab(
      await A.browserGetWindowInfo(cdp),
      base.windowId,
      tab,
    );
    assert.equal(
      after?.isForeground,
      before?.isForeground,
      "capturing must not change the foreground tab (that would steal the page the user is reading)",
    );
    assert.ok((snap.annotatedImage?.length ?? 0) > 100, "the annotated image should hold content");
    assert.ok(snap.annotatedContent.length > 10, "annotatedContent should hold content");
    // The kernel sends JSON text; only successful parsing proves the annotation structure really arrived.
    const parsed = JSON.parse(snap.annotatedContent) as Record<string, unknown>;
    assert.ok("children" in parsed, "annotatedContent should be the annotation tree as JSON");
  });

  it("human handover: writes are refused afterwards, and snapshots remain readable only while the tab is in the foreground", async () => {
    // A measured detail: a handover makes the tab no longer an agent tab, and "force the window to paint"
    // applies only to agent tabs. So capturing a **background** tab after a handover hangs (still no
    // reply after 8 seconds), and the pdl's "reading remains available" only holds while it is in the
    // foreground. Here it is brought forward first (still an agent tab, so that is allowed) and then handed over.
    await A.browserSelectTab(cdp, { windowId: base.windowId, tabId: tab });

    const start = await A.browserStartHumanControl(cdp, {
      windowId: base.windowId,
      tabId: tab,
      showWindow: false,
    });
    assert.ok(start.ok, start.text);

    // Reading: a foreground tab stays readable through the handover — which is exactly how one notices the person has finished.
    const snap = await A.takeSnapshot(cdp, {
      windowId: base.windowId,
      tabId: tab,
      url: "https://example.org/",
    });
    assert.ok(snap.annotatedContent.length > 0, "a foreground tab must stay readable during a handover");

    // Writing: must fail.
    const click = await A.browserClick(cdp, {
      x: 10,
      y: 10,
      windowId: base.windowId,
      tabId: tab,
      snapshotId: snap.snapshotId,
    });
    assert.equal(click.ok, false, "clicking must fail during a handover");
    assert.match(click.text, /human control/i);

    const stop = await A.browserStopHumanControl(cdp, {
      windowId: base.windowId,
      tabId: tab,
    });
    assert.ok(stop.ok, stop.text);
    assert.equal(stop.data!.reason, "agentRequested");

    // Writing works again once control is taken back.
    const after = await A.browserClick(cdp, {
      x: 10,
      y: 10,
      windowId: base.windowId,
      tabId: tab,
      snapshotId: snap.snapshotId,
    });
    assert.ok(after.ok, "operations should work again after taking control back: " + after.text);
  });

  it("concurrent multi-tab capture: background tabs produce images as usual, without stealing the foreground", async () => {
    // This is the core assumption of the new design. A fake CDP can only prove "we capture the list we
    // were given"; a real machine has to prove that background tabs really do produce images, that
    // concurrency really is faster, and that the foreground really was left alone.
    const extra: string[] = [];
    try {
      for (const url of ["https://example.com/", "https://example.org/"]) {
        const r = await A.browserAddNewTab(cdp, {
          windowId: base.windowId,
          url,
          waitUntil: "title",
        });
        assert.ok(r.ok, r.text);
        extra.push(String(r.data!.tabId));
      }

      const fgBefore = (await A.browserGetWindowInfo(cdp))
        .find((w) => w.windowId === base.windowId)!
        .tabs.filter((t) => t.isForeground)
        .map((t) => t.tabId);

      const t0 = Date.now();
      const shots = await Promise.all(
        extra.map((tabId) =>
          A.takeSnapshot(cdp, { windowId: base.windowId, tabId, url: "x" }),
        ),
      );
      const elapsed = Date.now() - t0;

      assert.equal(shots.length, 2);
      for (const shot of shots) {
        assert.ok((shot.annotatedImage?.length ?? 0) > 100, "every capture needs an image");
        assert.ok(shot.annotatedContent.length > 10, "every capture needs annotation text");
      }
      assert.deepEqual(
        shots.map((s) => s.tabId).sort(),
        [...extra].sort(),
        "every image must be attributable to its tab (with several images, emsn namespaces are told apart by it)",
      );

      const fgAfter = (await A.browserGetWindowInfo(cdp))
        .find((w) => w.windowId === base.windowId)!
        .tabs.filter((t) => t.isForeground)
        .map((t) => t.tabId);
      assert.deepEqual(
        fgAfter,
        fgBefore,
        "capturing several background tabs concurrently must not change the foreground tab",
      );

      // No assertion on the exact timing (machines vary), only that it has not regressed to "each one waiting for a paint that never comes".
      assert.ok(
        elapsed < 5000,
        `capturing two background tabs concurrently took ${elapsed}ms, which suggests a return to waiting for paints`,
      );
    } finally {
      for (const tabId of extra) {
        await A.browserCloseTab(cdp, { windowId: base.windowId, tabId }).catch(
          () => {},
        );
      }
    }
  });

  it("a background tab handed to a person can still be captured (it used to hang)", async () => {
    // Before 0.9.0.0 this asserted a hang: a tab that was no longer an agent tab got no forced paint, so a
    // capture waited forever, and the runtime had to rule such tabs out first. Since 0.9.0.0
    // (likely the kernel's "support background tab" change) it answers in about a second with an image,
    // so the rule is gone. Should this go red, bring the rule in snapshotBlockedReason back.
    const r = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: "https://example.com/",
      waitUntil: "title",
    });
    assert.ok(r.ok, r.text);
    const t = String(r.data!.tabId);
    try {
      const handoff = await A.browserStartHumanControl(cdp, {
        windowId: base.windowId,
        tabId: t,
        showWindow: false,
      });
      assert.ok(handoff.ok, handoff.text);

      const info = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, t);
      assert.equal(info?.isAgentTab, false, "after a handover it should no longer be an agent tab");
      assert.equal(info?.isForeground, false, "and it should still be in the background");
      assert.equal(snapshotBlockedReason({ tabId: t, url: info!.url }), null);

      const reply = await cdp.sendCommand(
        "Embiody.browserTakeSnapshot",
        {
          targets: [
            {
              windowId: base.windowId,
              tabs: [{ tabId: t, returnImage: false, returnAnnotatedImage: true }],
            },
          ],
        },
        8000,
      );
      const entry = reply.windows[0].tabs[0];
      assert.equal(entry.success, true, entry.message);
      assert.ok(entry.snapshotId, "a snapshotId");
      assert.ok((entry.annotatedImage?.length ?? 0) > 0, "an image");
    } finally {
      await A.browserStopHumanControl(cdp, {
        windowId: base.windowId,
        tabId: t,
      }).catch(() => {});
      await A.browserCloseTab(cdp, {
        windowId: base.windowId,
        tabId: t,
      }).catch(() => {});
    }
  });

  it("an empty document gives an empty but valid reply, which we count as a failure with the right retry advice", async () => {
    // The kernel side (since September 2026): an image, an empty tree and a snapshotId, plus a message that
    // says whether capturing again can help. Our side (since September 2026): an empty tree is a failure
    // for the model, and that message decides whether it is worth one recapture.
    const cases: Array<[string, string, boolean]> = [
      ["an empty body", "data:text/html," + encodeURIComponent("<html><body></body></html>"), false],
      ["a div with only a background colour", "data:text/html," + encodeURIComponent('<html><body><div style="width:300px;height:200px;background:red"></div></body></html>'), false],
      ["about:blank", "about:blank", true],
    ];
    const opened = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: "https://example.com/",
      waitUntil: "title",
    });
    assert.ok(opened.ok, opened.text);
    const probe = String(opened.data!.tabId);
    try {
      for (const [label, url, sameNextTime] of cases) {
        const nav = await A.browserNavigate(cdp, {
          url,
          windowId: base.windowId,
          tabId: probe,
          waitUntil: url === "about:blank" ? "commit" : "title",
          timeoutMs: 5000,
        });
        assert.ok(nav.ok, `${label} failed to navigate: ${nav.text}`);

        const reply = await cdp.sendCommand("Embiody.browserTakeSnapshot", {
          targets: [
            {
              windowId: base.windowId,
              tabs: [{ tabId: probe, returnImage: false, returnAnnotatedImage: true }],
            },
          ],
        });
        const entry = reply.windows[0].tabs[0];
        assert.equal(entry.success, true, `${label}: ${entry.message}`);
        assert.ok(entry.snapshotId, `${label} should return a snapshotId`);
        assert.ok((entry.annotatedImage?.length ?? 0) > 0, `${label} should return an image`);
        assert.deepEqual(JSON.parse(entry.annotatedContent).children, [], `${label}'s tree should be empty`);

        const batch = await A.takeSnapshots(cdp, {
          targets: [{ windowId: base.windowId, tabId: probe }],
        });
        assert.equal(batch.snapshots.length, 0, `${label} should count as a failure for the model`);
        assert.equal(
          A.isDeterministicSnapshotFailure(batch.failures[0].raw ?? ""),
          sameNextTime,
          `${label}: whether capturing again can help (${batch.failures[0].raw})`,
        );
      }
    } finally {
      await A.browserCloseTab(cdp, {
        windowId: base.windowId,
        tabId: probe,
      }).catch(() => {});
    }
  });

  it("chrome://newtab can be captured (so it must not be treated as an uncapturable blank page)", async () => {
    const opened = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: "chrome://newtab",
      waitUntil: "title",
    });
    assert.ok(opened.ok, opened.text);
    const t = String(opened.data!.tabId);
    try {
      const info = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, t);
      assert.match(
        info!.url,
        /new-tab-page/,
        "chrome://newtab lands on chrome://new-tab-page/",
      );
      assert.equal(
        snapshotBlockedReason({ tabId: t, url: info!.url }),
        null,
        "the runtime must not treat it as an uncapturable tab",
      );
      const snap = await A.takeSnapshot(cdp, {
        windowId: base.windowId,
        tabId: t,
        url: info!.url,
      });
      assert.ok(snap.annotatedContent.length > 0);
      assert.ok((snap.annotatedImage?.length ?? 0) > 100);
    } finally {
      await A.browserCloseTab(cdp, {
        windowId: base.windowId,
        tabId: t,
      }).catch(() => {});
    }
  });

  it("snapshotId: an older batch of the same page takes an emsn but not a point, navigation voids it, a DOM swap is refused", async () => {
    // This pins the current state of batch execution safety. The snapshotId (September 2026) closed two cases:
    //   using the numbers from a previous capture -> refused before any input is sent
    //                                                (since October 2026: only for a point; an emsn keeps working)
    //   after navigating or reloading            -> the id is void, likewise refused
    // Case 3 — a same-document DOM swap (an SPA re-render) — is **also refused**, even though it is
    // not one of the two invalidation rules the pdl lists ("another snapshot", "navigate or reload"),
    // because the emsn layer has a live check of its own: the node has been removed from the DOM, so
    // "emsn N is not rendered any more".
    //
    // This once asserted the opposite behaviour ("reports a false success"). That conclusion was wrong
    // and came from an unreliable probe script: it triggered the swap with Runtime.evaluate, and
    // whether the swap happened in the tab under test **was never verified**. The lesson is in test/README.md.
    // Element numbers only: the page itself is emsn "-1" (since late September 2026), which the old pattern read as 1.
    const emsnsOf = (content: string): number[] =>
      [...content.matchAll(/"emsn"\s*:\s*"?(-?\d+)/g)].map((m) => Number(m[1])).filter((n) => n >= 0);
    const dataUrl = (html: string) => "data:text/html," + encodeURIComponent(html);

    const opened = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: "https://example.com/",
      waitUntil: "title",
    });
    assert.ok(opened.ok, opened.text);
    const t = String(opened.data!.tabId);
    const T = { windowId: base.windowId, tabId: t };
    try {
      // -- Case 1: an older batch of the same page --
      await A.browserNavigate(cdp, {
        url: dataUrl("<html><head><title>P</title></head><body><button>BTN</button></body></html>"),
        ...T,
        waitUntil: "title",
      });
      const first = await A.takeSnapshot(cdp, { ...T, url: "p" });
      const [emsn] = emsnsOf(first.annotatedContent);
      assert.equal(typeof emsn, "number", "the page should hold a clickable element");

      const second = await A.takeSnapshot(cdp, { ...T, url: "p" });
      assert.notEqual(second.snapshotId, first.snapshotId, "capturing again should give a new batch");

      // Since October 2026 a snapshotId names the page: an emsn from any of its snapshots still works,
      // while a point needs the latest one, which the refusal names.
      const byNumber = await A.browserClick(cdp, { emsn, ...T, snapshotId: first.snapshotId });
      assert.ok(byNumber.ok, "an emsn from an older snapshot of the same page must work: " + byNumber.text);
      const byPoint = await A.browserClick(cdp, { x: 5, y: 5, ...T, snapshotId: first.snapshotId });
      assert.equal(byPoint.ok, false, "a point with an older snapshot must be refused: " + byPoint.text);
      assert.ok(
        byPoint.text.includes(second.snapshotId),
        "the refusal should say which snapshot is the latest: " + byPoint.text,
      );

      // -- Case 2: navigation voids the id --
      const beforeNav = await A.takeSnapshot(cdp, { ...T, url: "p" });
      await A.browserNavigate(cdp, {
        url: dataUrl("<html><head><title>Q</title></head><body><button>OTHER</button></body></html>"),
        ...T,
        waitUntil: "title",
      });
      const afterNav = await A.browserClick(cdp, {
        emsn,
        ...T,
        snapshotId: beforeNav.snapshotId,
      });
      assert.equal(afterNav.ok, false, "after navigating the old id must be void: " + afterNav.text);

      // -- Case 3: a same-document DOM swap (using the repro page in the repository; it swaps on its own
      //    timer, so no Runtime.evaluate is needed — which tab that command lands on is not controllable) --
      const reproPage =
        "file:///" +
        process.cwd().split("\\").join("/") +
        "/test/fixtures/stale-emsn-repro.html";
      await A.browserNavigate(cdp, {
        url: reproPage,
        ...T,
        waitUntil: "load",
      });
      const beforeSwap = await A.takeSnapshot(cdp, { ...T, url: reproPage });
      const [emsnR] = emsnsOf(beforeSwap.annotatedContent);
      assert.equal(typeof emsnR, "number", "the repro page should hold a clickable button before the swap");
      // Wait for the page to swap its own DOM. **Judged only by reading the title through
      // browserGetWindowInfo** — taking another snapshot to "confirm the DOM changed" would void the
      // old id, and the test would then measure "we captured again" rather than "the DOM changed".
      // (We fell into that once.)
      const deadline = Date.now() + 8000;
      let swapped = false;
      while (Date.now() < deadline) {
        const cur = A.findTab(
          await A.browserGetWindowInfo(cdp),
          base.windowId,
          t,
        )?.title;
        if (cur === "SWAPPED") {
          swapped = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(swapped, "the repro page should swap its DOM after 3 seconds");

      const afterSwap = await A.browserClick(cdp, {
        emsn: emsnR,
        ...T,
        snapshotId: beforeSwap.snapshotId,
      });
      assert.equal(
        afterSwap.ok,
        false,
        "after a same-document swap the old number must be refused too: " + afterSwap.text,
      );
      assert.match(
        afterSwap.text,
        /not rendered any more|page has changed/i,
        "the reason should be 'that node is gone', not 'the wrong batch'",
      );
      const titleAfter = A.findTab(
        await A.browserGetWindowInfo(cdp),
        base.windowId,
        t,
      )?.title;
      assert.equal(
        titleAfter,
        "SWAPPED",
        "being refused means nothing was clicked, so the page state must not change",
      );
    } finally {
      await A.browserCloseTab(cdp, T).catch(() => {});
    }
  });

  it("a snapshot brings back a real permission bubble; dismiss closes it and reports appliedAction", async () => {
    // Geolocation is used: the pdl says allowOnce is offered only on permissions with a genuine
    // session-scoped grant, and of those the model will meet, only geolocation qualifies — so this one
    // case verifies all five actions appear in availableActions.
    const page =
      "file:///" +
      process.cwd().split("\\").join("/") +
      "/test/fixtures/permission-popup.html";
    const opened = await A.browserAddNewTab(cdp, {
      windowId: base.windowId,
      url: page,
      foreground: true,
      waitUntil: "load",
    });
    assert.ok(opened.ok, opened.text);
    const t = String(opened.data!.tabId);
    const T = { windowId: base.windowId, tabId: t };
    try {
      // The bubble takes a moment to appear.
      let snap = await A.takeSnapshot(cdp, { ...T, url: page });
      for (let i = 0; i < 20 && snap.popups.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 250));
        snap = await A.takeSnapshot(cdp, { ...T, url: page });
      }
      assert.ok(
        snap.popups.length > 0,
        "requesting geolocation should raise a permission bubble and show up in popups (if this profile already remembers the decision it will not appear; delete the derived profile and run again)",
      );
      const perm = snap.popups.find((x) => x.type === "permission");
      assert.ok(perm, "there should be a popup with type=permission");
      assert.ok(perm!.message, "a permission bubble should carry a message (the pdl says it has a message and no title)");
      assert.deepEqual(
        [...perm!.availableActions].sort(),
        ["allow", "allowOnce", "deny", "dismiss", "ignore"].sort(),
        "geolocation should offer all five actions",
      );

      // dismiss: refuse without writing to the profile, which is our default and recommendation.
      const closed = await A.browserClosePopupBubble(cdp, {
        action: "dismiss",
        ...T,
      });
      assert.ok(closed.ok, closed.text);
      assert.equal(closed.data!.closed, true);
      assert.equal(closed.data!.appliedAction, "dismiss");
      assert.match(closed.text, /dismiss/);
      assert.doesNotMatch(
        closed.text,
        /written into the browser profile/,
        "dismiss does not persist, so that warning should not appear",
      );

      const after = await A.takeSnapshot(cdp, { ...T, url: page });
      assert.equal(after.popups.length, 0, "popups should be empty after closing it");
    } finally {
      await A.browserCloseTab(cdp, T).catch(() => {});
    }
  });

  it("the commands we no longer call really have become hard errors or been removed in the kernel", async () => {
    // Confirms sections two and three of the list from the other direction: these commands all used to
    // succeed falsely. If they ever "succeed" again, the browser side has regressed and our tool
    // descriptions have to follow.
    for (const method of [
      "Embiody.waitForElement",
      "Embiody.freezeRender",
      "Embiody.unfreezeRender",
      "Embiody.getComputedLabel",
      "Embiody.getSemanticRole",
      "Embiody.manageCookies",
      "Embiody.provideAuthResponse",
      "Embiody.browserStartup",
      "Embiody.browserGetWindowInfos",
      // Renamed in late September 2026 to browserStopLoading / browserCloseWindow.
      "Embiody.browserStop",
      "Embiody.browserClose",
    ]) {
      await assert.rejects(
        () => cdp.sendCommand(method, {}),
        (e: unknown) => {
          const m = e instanceof Error ? e.message : String(e);
          assert.match(
            m,
            /wasn't found|Not implemented|Invalid parameters/i,
            `${method} did not error at all: ${m}`,
          );
          return true;
        },
        `${method} should fail (unimplemented / removed / renamed)`,
      );
    }
  });

  // ------------------------------------------- 2026-09-28 kernel deliveries

  const fixture = (name: string) =>
    "file:///" + process.cwd().split("\\").join("/") + "/test/fixtures/" + name;

  /** Entries of an annotatedContent tree with their text and the address they are in (inherited from the nearest ancestor that has one). */
  function entries(tree: any): Array<{ node: any; text: string; href?: string }> {
    const out: Array<{ node: any; text: string; href?: string }> = [];
    const walk = (n: any, inherited?: string) => {
      const href = typeof n?.href === "string" ? n.href : inherited;
      const text = (n?.text_runs ?? []).map((r: any) => r.text).join(" ");
      if (n?.node_name !== undefined) out.push({ node: n, text, href });
      for (const c of n?.children ?? []) walk(c, href);
    };
    walk(tree);
    return out;
  }

  async function rawSnapshot(tabId: string, extra: Record<string, unknown> = {}) {
    const reply = await cdp.sendCommand(
      "Embiody.browserTakeSnapshot",
      { targets: [{ windowId: base.windowId, tabs: [{ tabId, returnImage: false, returnAnnotatedImage: false, ...extra }] }] },
      30000,
    );
    const entry = reply.windows[0].tabs[0];
    assert.equal(entry.success, true, entry.message);
    return JSON.parse(entry.annotatedContent);
  }

  async function openFixture(name: string): Promise<string> {
    const r = await A.browserAddNewTab(cdp, { windowId: base.windowId, url: fixture(name), waitUntil: "load" });
    assert.ok(r.ok, r.text);
    return String(r.data!.tabId);
  }

  it("every emsn in annotatedContent is an integer, the page's -1 included", async () => {
    const t = await openFixture("links.html");
    try {
      const tree = await rawSnapshot(t);
      const numbers = [
        ...entries(tree).map((e) => e.node.emsn).filter((v) => v !== undefined),
        ...(tree.current_scroll_chain ?? []).map((l: any) => l.emsn),
      ];
      assert.ok(numbers.length > 5);
      assert.ok(numbers.every((v) => Number.isInteger(v)), JSON.stringify(numbers));
      assert.ok(numbers.includes(-1), "the page's own -1");
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });

  it("returnHref gives absolute addresses, none for javascript:, data: cut at the comma, nothing when off", async () => {
    const t = await openFixture("links.html");
    try {
      const all = entries(await rawSnapshot(t, { returnHref: true }));
      const hrefOf = (words: string) => all.find((e) => e.text.includes(words))?.href;
      assert.equal(hrefOf("plain link"), "https://example.com/plain?q=a&p=2", "as the page has it, unescaped");
      assert.equal(hrefOf("relative link"), fixture("stale-emsn-repro.html"), "made absolute");
      assert.equal(hrefOf("highlighted"), "https://example.com/pieces", "a piece inside a link");
      assert.equal(all.find((e) => e.node.node_name === "IMG")?.href, "https://example.com/image", "an image link");
      assert.equal(hrefOf("javascript link"), undefined);
      assert.equal(hrefOf("data link"), "data:text/plain;base64,…");
      assert.equal(JSON.stringify(await rawSnapshot(t)).includes('"href"'), false, "off by default");
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });

  it("a tab opened from an agent tab is the agent's, and closes at once", async () => {
    const t = await openFixture("links.html");
    const opened: string[] = [];
    try {
      const ways: Array<[string, RegExp, "left" | "middle"]> = [
        ["middle click", /relative link/, "middle"],
        ["target=_blank", /opens a new tab/, "left"],
        ["window.open", /window\.open button/, "left"],
      ];
      for (const [way, label, button] of ways) {
        const shot = await A.takeSnapshot(cdp, { windowId: base.windowId, tabId: t, image: false });
        const emsn = Number([...(shot.emsnLines ?? [])].find(([, line]) => label.test(line))![0]);
        const before = new Set((await A.browserGetWindowInfo(cdp)).flatMap((w) => w.tabs.map((x) => x.tabId)));
        const click = await A.browserClick(cdp, { windowId: base.windowId, tabId: t, snapshotId: shot.snapshotId, emsn, button });
        assert.ok(click.ok, click.text);
        let child: { tabId: string; isAgentTab: boolean } | undefined;
        for (let i = 0; i < 20 && !child; i++) {
          await new Promise((r) => setTimeout(r, 200));
          child = (await A.browserGetWindowInfo(cdp)).flatMap((w) => w.tabs).find((x) => !before.has(x.tabId));
        }
        assert.ok(child, way + " opened no tab");
        opened.push(child!.tabId);
        assert.equal(child!.isAgentTab, true, way + ": the new tab should be the agent's");
        const t0 = Date.now();
        const closed = await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: child!.tabId });
        assert.ok(closed.ok, closed.text);
        assert.ok(Date.now() - t0 < 2000, way + ": closing asked the person (" + (Date.now() - t0) + " ms)");
      }
    } finally {
      for (const id of [t, ...opened]) {
        await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: id }).catch(() => {});
      }
    }
  });

  it("a whole-page read of a tall page reaches the end in reasonable time", async () => {
    const t = await openFixture("long-page.html?n=3000");
    try {
      const around = await A.takeSnapshots(cdp, { targets: [{ windowId: base.windowId, tabId: t, long: true, image: false }] });
      assert.doesNotMatch(around.snapshots[0].rendered, /the end/, "8000px each way should not reach the bottom");
      const t0 = Date.now();
      const whole = await A.takeSnapshots(cdp, { targets: [{ windowId: base.windowId, tabId: t, wholePage: true, image: false }], timeoutMs: 20000 });
      const ms = Date.now() - t0;
      assert.equal(whole.failures.length, 0, JSON.stringify(whole.failures));
      assert.match(whole.snapshots[0].rendered, /the end/);
      console.log("    whole page of 3000 paragraphs: " + ms + " ms");
      assert.ok(ms < 15000, "took " + ms + " ms");
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });
  it("F0: browserInputText sets a SELECT by its option's text and a date field, without a picker", async () => {
    const t = await openFixture("form-controls.html");
    try {
      const shot = (await A.takeSnapshots(cdp, { targets: [{ windowId: base.windowId, tabId: t, image: false }] })).snapshots[0];
      const numberOf = (re: RegExp) => Number(shot.rendered.split("\n").find((l) => re.test(l))?.match(/^(\d+) /)?.[1]);
      const select = numberOf(/ SELECT /);
      const day = numberOf(/ INPUT:date/);
      assert.match(shot.rendered, /options "Sydney" "Melbourne" "Perth" "Brisbane"/);
      const T = { windowId: base.windowId, tabId: t, snapshotId: shot.snapshotId };
      const chosen = await A.browserInputText(cdp, { ...T, emsn: select, text: "Brisbane" });
      assert.ok(chosen.ok, chosen.text);
      const refused = await A.browserInputText(cdp, { ...T, emsn: select, text: "Perth" });
      assert.equal(refused.ok, false, "a disabled option must be refused");
      const dated = await A.browserInputText(cdp, { ...T, emsn: day, text: "2026-12-25" });
      assert.ok(dated.ok, dated.text);
      const title = A.findTab(await A.browserGetWindowInfo(cdp), base.windowId, t)?.title;
      assert.equal(title, "city=Brisbane day=2026-12-25", "the page should see trusted change events");
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });

  // The kernel's timeoutMs covers every repeat of a scroll; at its 7 s default, 12 wheels failed.
  it("F0: a long repeated scroll gets room for every wheel and replies at rest", async () => {
    const t = await openFixture("long-page.html?n=3000");
    try {
      const r = await A.browserScroll(cdp, { windowId: base.windowId, tabId: t, deltaY: 200, repeatCount: 12 });
      assert.ok(r.ok, r.text);
      const shot = (await A.takeSnapshots(cdp, { targets: [{ windowId: base.windowId, tabId: t, image: false }] })).snapshots[0];
      assert.match(shot.position ?? "", /shows 2[34]\d\d-/, "twelve wheels of 200px, read right after the reply");
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });
  describe("editing, keys and selecting", () => {
    let t = "";
    let T: { windowId: string; tabId: string; snapshotId: string };
    let numberOf: (name: string) => number;
    // A fresh snapshot after each change: the commands check snapshotId against the page.
    const look = async () => {
      const shot = (await A.takeSnapshots(cdp, { targets: [{ windowId: base.windowId, tabId: t, image: false }] })).snapshots[0];
      T = { windowId: base.windowId, tabId: t, snapshotId: shot.snapshotId };
      numberOf = (name) => Number(shot.rendered.split("\n").find((l) => l.includes(`[${name}]`))?.match(/^\s*(\d+) /)?.[1]);
      return shot.rendered;
    };
    before(async () => {
      t = await openFixture("editing.html");
      await look();
    });
    after(async () => {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    });

    it("browserInputText types at a place named by the words, and reads the line back", async () => {
      const r = await A.browserInputText(cdp, { ...T, emsn: numberOf("Note"), text: ",", after: "hello" });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /hello,‸ world/);
      await look();
      const missing = await A.browserInputText(cdp, { ...T, emsn: numberOf("Note"), text: "x", before: "no such words" });
      assert.equal(missing.ok, false, "words that are not there type nothing");
    });

    it("browserPressKey moves the caret for the next typing; a copy shortcut is refused and presses nothing", async () => {
      await look();
      const end = await A.browserPressKey(cdp, { ...T, emsn: numberOf("Line"), keys: [{ key: "End" }] });
      assert.ok(end.ok, end.text);
      const typed = await A.browserInputText(cdp, { ...T, text: "d" });
      assert.ok(typed.ok, typed.text);
      assert.match(await look(), /\[Line\][^\n]*"abcd/);
      const copy = await A.browserPressKey(cdp, { ...T, keys: [{ key: "Control+C" }] });
      assert.equal(copy.ok, false, copy.text);
    });

    it("browserSelectEditableText selects the words, also from a mention's edge; a password field is refused", async () => {
      await look();
      const words = await A.browserSelectEditableText(cdp, { ...T, emsn: numberOf("Body"), select: "喜欢这个" });
      assert.ok(words.ok, words.text);
      assert.match(words.text, /我很⟦喜欢这个⟧方案/);
      const edge = await A.browserSelectEditableText(cdp, { ...T, emsn: numberOf("Body"), select: "@张三看一下" });
      assert.ok(edge.ok, edge.text);
      const secret = await A.browserSelectEditableText(cdp, { ...T, emsn: numberOf("Secret"), all: true });
      assert.equal(secret.ok, false, secret.text);
      assert.match(secret.text, /password/);
    });

    it("an Embiody command refuses a parameter name it does not take", async () => {
      await assert.rejects(
        () => cdp.sendCommand("Embiody.browserReload", { windowId: base.windowId, tabId: t, notAParameter: 1 }),
        /notAParameter/,
      );
    });
  });

  // On F0 before bdd103d963 a toY more than ~6000px away stopped 5-12% short and failed at timeoutMs.
  it("F0: toY 999999 reaches the bottom of a long page", async () => {
    const t = await openFixture("long-page.html?n=2000");
    try {
      const r = await A.browserScroll(cdp, { windowId: base.windowId, tabId: t, toY: 999999 });
      assert.ok(r.ok, r.text);
    } finally {
      await A.browserCloseTab(cdp, { windowId: base.windowId, tabId: t }).catch(() => {});
    }
  });
});
