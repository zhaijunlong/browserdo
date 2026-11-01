import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// The notice is also logged; keep it out of the real log. Read once when config.ts loads.
process.env.EMBIODY_DEBUG_LOG = path.join(os.tmpdir(), "browserdo-test", String(process.pid), "debug.log");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = await import("../../src/server.js");
const { INSTALL_NOTICE, noteInstalled } = await import("../../src/install_notice.js");
import type { CdpClient } from "../../src/cdp-client.js";

/** After installing Embiody, the next tool reply tells the agent the terms, so it can tell the person. */
describe("the install notice", () => {
  it("leads the first tool reply after an install, and only that one", async () => {
    const server = createMcpServer({} as CdpClient, "all");
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async () =>
      ((await client.callTool({ name: "browser_stop_task", arguments: { taskId: "none" } })).content as Array<{ text: string }>).map((c) => c.text);

    assert.ok(!(await call()).includes(INSTALL_NOTICE), "nothing installed yet");
    noteInstalled();
    const first = await call();
    assert.equal(first[0], INSTALL_NOTICE);
    assert.match(first[1], /does not exist/, "the tool's own reply follows");
    assert.ok(!(await call()).includes(INSTALL_NOTICE));
    await client.close();
  });
});
