import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Shared-profile mode, with resetProfile on, and the person's folders moved into a temp
// directory: if the refusal below ever failed, it would delete only that. config.ts reads these
// once when it loads, so they are set before importing it.
const home = mkdtempSync(path.join(os.tmpdir(), "browserdo-shared-"));
delete process.env.EMBIODY_USER_DATA_DIR;
delete process.env.EMBIODY_EXE_PATH;
process.env.LOCALAPPDATA = home;
process.env.EMBIODY_RESET_PROFILE = "1";
process.env.EMBIODY_DEBUG_LOG = path.join(home, "debug.log");
const { EMBIODY_USER_DATA_DIR, SHARED_PROFILE, expandPolicyPath, sharedUserDataDir } = await import("../../src/config.js");
const { SHARED_LAUNCH_ARGS, readExistingPort, resetUserDataDir } = await import("../../src/embiody-browser.js");

after(() => rmSync(home, { recursive: true, force: true }));

describe("sharing the person's own Embiody", () => {
  it("is the default, in the browser's own user data folder", () => {
    assert.equal(SHARED_PROFILE, true);
    assert.equal(EMBIODY_USER_DATA_DIR, path.join(home, "Embiody", "Embiody", "User Data"));
  });

  it("follows the UserDataDir policy when one is set, expanding its per-user variables", () => {
    assert.equal(sharedUserDataDir("C:/path/to/${user_name}/Embiody"), `C:/path/to/${process.env.USERNAME}/Embiody`);
    const env = { LOCALAPPDATA: "C:/path/to/L", APPDATA: "C:/path/to/R", USERPROFILE: "C:/path/to/U" };
    assert.equal(
      expandPolicyPath("${local_app_data}/a|${roaming_app_data}|${profile}", env),
      "C:/path/to/L/a|C:/path/to/R|C:/path/to/U",
    );
    assert.equal(expandPolicyPath("${unknown}/x", env), "${unknown}/x", "a variable it cannot fill is left as written");
  });

  it("starts the browser as a double-click would, on the Default profile, with none of our flags", () => {
    assert.deepEqual(SHARED_LAUNCH_ARGS, ["--profile-directory=Default"]);
  });

  it("refuses resetProfile rather than delete the person's profile", async () => {
    mkdirSync(EMBIODY_USER_DATA_DIR, { recursive: true });
    writeFileSync(path.join(EMBIODY_USER_DATA_DIR, "Local State"), "{}");
    await assert.rejects(resetUserDataDir(), /would delete the person's own Embiody profile/);
    assert.ok(existsSync(path.join(EMBIODY_USER_DATA_DIR, "Local State")));
  });
});

describe("reading the browser's port file", () => {
  const dir = mkdtempSync(path.join(home, "ports-"));
  const write = (name: string, text: string) => writeFileSync(path.join(dir, name), text);
  const clear = () => {
    for (const f of ["EmbiodyAgentPort", "DevToolsActivePort"]) rmSync(path.join(dir, f), { force: true });
  };
  // A pid that has just exited.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;

  it("takes EmbiodyAgentPort while its browser pid is alive", () => {
    clear();
    write("EmbiodyAgentPort", `51234\n/devtools/browser/abc\n${process.pid}\n`);
    write("DevToolsActivePort", "40000\n/devtools/browser/old\n");
    assert.equal(readExistingPort(dir), 51234);
  });

  it("drops it, and the DevToolsActivePort a crash left beside it, once that pid is gone", () => {
    clear();
    write("EmbiodyAgentPort", `51234\n/devtools/browser/abc\n${deadPid}\n`);
    write("DevToolsActivePort", "51234\n/devtools/browser/abc\n");
    assert.equal(readExistingPort(dir), null);
  });

  it("uses DevToolsActivePort until EmbiodyAgentPort is written", () => {
    clear();
    write("DevToolsActivePort", "40000\n/devtools/browser/x\n");
    assert.equal(readExistingPort(dir), 40000);
  });

  it("gives null for no file or a port that is not a number", () => {
    clear();
    assert.equal(readExistingPort(dir), null);
    write("EmbiodyAgentPort", "not-a-port\n");
    assert.equal(readExistingPort(dir), null);
  });
});
