import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { acquireInstallLock } from "../../src/install_lock.js";

const pipe = `\\\\.\\pipe\\browserdo-install-test-${process.pid}`;

describe("install lock", { skip: process.platform !== "win32" }, () => {
  it("is held by one taker at a time and free again once released", async () => {
    const first = await acquireInstallLock(pipe);
    assert.ok(first);
    assert.equal(await acquireInstallLock(pipe), null);
    first.release();
    const again = await acquireInstallLock(pipe);
    assert.ok(again);
    again.release();
  });

  it("is freed when its holder is killed", async () => {
    const code = `require("node:net").createServer().listen(${JSON.stringify(pipe)}, () => console.log("held"))`;
    const holder = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    assert.equal(await acquireInstallLock(pipe), null);
    holder.kill();
    await new Promise((resolve) => holder.once("exit", resolve));
    const lock = await acquireInstallLock(pipe);
    assert.ok(lock);
    lock.release();
  });
});
