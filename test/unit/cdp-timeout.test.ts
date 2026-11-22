import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandTimeoutMs } from "../../src/cdp-client.js";
import { CDP_COMMAND_TIMEOUT_MS } from "../../src/config.js";

describe("CDP command timeout", () => {
  it("a command that may ask the person gets 25 s on top, of the default or of its own", () => {
    assert.equal(commandTimeoutMs("Embiody.browserCloseTab"), CDP_COMMAND_TIMEOUT_MS + 25_000);
    assert.equal(commandTimeoutMs("Embiody.browserClick", 5_000), 30_000);
  });

  it("other commands keep their own time", () => {
    assert.equal(commandTimeoutMs("Embiody.browserTakeSnapshot"), CDP_COMMAND_TIMEOUT_MS);
    assert.equal(commandTimeoutMs("Embiody.browserNewTab", 5_000), 5_000);
    assert.equal(commandTimeoutMs("browserCloseTab"), CDP_COMMAND_TIMEOUT_MS, "only the Embiody domain's command");
  });
});
