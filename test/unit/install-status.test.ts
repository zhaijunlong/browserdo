import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installProgress, onInstallRecheck, setInstallStatus } from "../../src/install_status.js";
import { EMBIODY_INSTALLER_NAME } from "../../src/config.js";

const MB = 1024 * 1024;

describe("install progress", () => {
  afterEach(() => {
    setInstallStatus({ phase: "idle" });
    onInstallRecheck(async () => {});
  });

  it("says nothing when nothing is being installed", () => {
    assert.equal(installProgress(), null);
  });

  it("gives MB done, MB in all and the time left while downloading", () => {
    // 47 of 141 MB in 60 s: 94 MB more at that pace is 120 s.
    setInstallStatus({ phase: "downloading", source: "GitHub", received: 47 * MB, total: 141 * MB, startedAt: 0 });
    assert.match(installProgress(60_000)!, /from GitHub \(47 of 141 MB, about 2 min left\)/);
    setInstallStatus({ phase: "downloading", source: "cnb", received: 140 * MB, total: 141 * MB, startedAt: 0 });
    assert.match(installProgress(60_000)!, /from cnb \(140 of 141 MB, under a minute left\)/);
  });

  it("gives no time left before there is a pace to go by, or without a size", () => {
    setInstallStatus({ phase: "downloading", source: "GitHub", received: 0, total: 141 * MB, startedAt: 0 });
    assert.match(installProgress(60_000)!, /\(0 of 141 MB\)/);
    setInstallStatus({ phase: "downloading", source: "GitHub", received: 10 * MB, total: null, startedAt: 0 });
    assert.match(installProgress(60_000)!, /\(10 MB so far\)/);
  });

  it("says when it is installing", () => {
    setInstallStatus({ phase: "installing" });
    assert.match(installProgress()!, /being installed/);
  });

  it("after a failure gives the reason and a manual download", () => {
    setInstallStatus({ phase: "failed", error: "GitHub: fetch failed; cnb: HTTP 503" });
    const text = installProgress()!;
    assert.match(text, /failed: GitHub: fetch failed; cnb: HTTP 503\. It is tried again the next time your client starts BrowserDo/);
    assert.ok(text.endsWith(EMBIODY_INSTALLER_NAME));
  });
});
