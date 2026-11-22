import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { downloadAndInstall, type InstallSteps } from "../../src/embiody-browser.js";
import { getInstallStatus, installProgress, setInstallStatus } from "../../src/install_status.js";

const said = "Setup cannot replace EmbiodyUpdater.exe because Windows Explorer is using it. Close that program and try again.";

/** Steps that log what they were asked, in order; reads give the answers queued for them. */
function steps(over: { cleared?: boolean; reads?: Array<string | null>; exe?: string | null; registerMs?: number } = {}) {
  const log: string[] = [];
  const reads = [...(over.reads ?? [])];
  const s: InstallSteps = {
    download: async () => (log.push("download"), "github"),
    run: async () => void log.push("run"),
    clearResult: async () => (log.push("clear"), over.cleared ?? true),
    readFileInUse: async () => (log.push("read"), reads.shift() ?? null),
    installedExe: async () => (log.push("registered?"), over.exe ?? null),
    registerMs: over.registerMs ?? 0,
  };
  return { s, log };
}

const failure = async (s: InstallSteps) => {
  setInstallStatus({ phase: "idle" });
  await assert.rejects(downloadAndInstall(s));
  return installProgress()!;
};

describe("downloadAndInstall: what an install that did not register says", () => {
  it("a file in use: the installer's words, said at once, without waiting for the browser", async () => {
    const { s, log } = steps({ reads: [said], registerMs: 60_000 });
    const text = await failure(s);
    assert.deepEqual(log, ["download", "clear", "run", "read"]);
    assert.equal(text.startsWith(`Installing the Embiody browser failed: ${said} Pass this on to the person: installing works once that program is closed. It is tried again`), true, text);
  });

  it("a file in use reported only after the wait: the same words", async () => {
    const { s, log } = steps({ reads: [null, said] });
    const text = await failure(s);
    assert.deepEqual(log, ["download", "clear", "run", "read", "read"]);
    assert.match(text, /failed: Setup cannot replace/);
  });

  it("no record of this install: the reason is unknown, as before", async () => {
    const { s } = steps();
    assert.match(await failure(s), /failed: Embiody is still not in the registry after installing\. It is tried again/);
  });

  it("a record that could not be cleared is never read: it may be an earlier one", async () => {
    const { s, log } = steps({ cleared: false, reads: [said, said] });
    assert.match(await failure(s), /still not in the registry/);
    assert.equal(log.includes("read"), false);
  });

  it("a download or installer that fails says its own reason, and the record is not touched for it", async () => {
    const download = steps();
    download.s.download = async () => { throw new Error("Downloading the installer failed"); };
    assert.match(await failure(download.s), /failed: Downloading the installer failed\./);
    assert.deepEqual(download.log, []);

    const run = steps({ reads: [said] });
    run.s.run = async () => { throw new Error("The installer did not finish within 20 minutes"); };
    assert.match(await failure(run.s), /failed: The installer did not finish within 20 minutes\./);
    assert.deepEqual(run.log, ["download", "clear"]);
  });

  it("registered: the exe path, and no failure", async () => {
    const { s, log } = steps({ reads: [null], exe: "C:/path/to/embiody.exe", registerMs: 10_000 });
    setInstallStatus({ phase: "idle" });
    assert.equal(await downloadAndInstall(s), "C:/path/to/embiody.exe");
    assert.deepEqual(log, ["download", "clear", "run", "read", "registered?"]);
    assert.notEqual(getInstallStatus().phase, "failed");
  });
});
