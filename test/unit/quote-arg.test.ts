import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { quoteArg } from "../../src/embiody-browser.js";

describe("quoteArg", { skip: process.platform !== "win32" }, () => {
  it("a Windows program gets each argument back unchanged", () => {
    const args = [
      "--profile-directory=Default",
      "--user-data-dir=C:/path/to/a b/User Data",
      "dir with space\\",
      'say "hi"',
      'a\\"b',
      "\\\\server\\share",
      "",
    ];
    const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    // "--" so that node does not take the browser flags as its own options.
    const commandLine = ["-e", script, "--", ...args].map(quoteArg).join(" ");
    const out = spawnSync(process.execPath, [commandLine], { windowsVerbatimArguments: true }).stdout.toString();
    assert.deepEqual(JSON.parse(out), args);
  });
});
