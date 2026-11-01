import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkEmbiodyVersion,
  compareVersions,
  MIN_EMBIODY_VERSION,
  parseEmbiodyVersion,
} from "../../src/browser_version.js";

describe("the Embiody version check", () => {
  it("reads the Embiody part of /json/version, not the Chrome part", () => {
    assert.equal(parseEmbiodyVersion("Chrome/156.0.8078.12 Embiody/0.9.0.4"), "0.9.0.4");
    assert.equal(parseEmbiodyVersion("Chrome/156.0.8078.12"), undefined);
    assert.equal(parseEmbiodyVersion(undefined), undefined);
  });

  it("compares part by part as numbers", () => {
    assert.equal(compareVersions("0.9.0.10", "0.9.0.4"), 1, "10 > 4, not as text");
    assert.equal(compareVersions("0.9.0.4", "0.9.0.4"), 0);
    assert.equal(compareVersions("0.9.1", "0.9.0.4"), 1, "a missing part counts as 0");
    assert.equal(compareVersions("0.8.9.99", "0.9.0.0"), -1);
  });

  it("accepts the minimum and newer, refuses older and unreadable", () => {
    assert.deepEqual(checkEmbiodyVersion(`Chrome/156.0.8078.12 Embiody/${MIN_EMBIODY_VERSION}`), { ok: true });
    assert.deepEqual(checkEmbiodyVersion("Chrome/157.0.1.1 Embiody/1.0.0.0"), { ok: true });

    const old = checkEmbiodyVersion("Chrome/156.0.8078.12 Embiody/0.9.0.2");
    assert.ok(!old.ok && old.tooOld);
    assert.match(old.message, new RegExp(`0\\.9\\.0\\.2.*${MIN_EMBIODY_VERSION.replace(/\./g, "\\.")}`));
    assert.match(old.message, /chrome:\/\/settings\/help.*restart the browser and then the BrowserDo MCP server/);

    const unknown = checkEmbiodyVersion("Chrome/156.0.8078.12");
    assert.ok(!unknown.ok && !unknown.tooOld);
    assert.match(unknown.message, /Could not read the Embiody version/);
  });
});
