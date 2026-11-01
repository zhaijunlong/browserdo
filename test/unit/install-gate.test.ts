import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

// Keep the debug log out of the real one. Read once when config.ts loads.
process.env.EMBIODY_DEBUG_LOG = path.join(os.tmpdir(), "browserdo-test", String(process.pid), "debug.log");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = await import("../../src/server.js");
const { onInstallRetry, setInstallStatus } = await import("../../src/install_status.js");
import type { CdpClient } from "../../src/cdp-client.js";

type Reply = { content: Array<{ text: string }>; isError?: boolean };

/** While BrowserDo installs the browser, tools answer at once with the progress instead of acting. */
describe("tools while the browser is being installed", () => {
  afterEach(() => {
    setInstallStatus({ phase: "idle" });
    onInstallRetry(() => {});
  });

  // {} as CdpClient: a tool that got as far as the browser would fail on it, not reply with progress.
  async function connect(cdp: object = {}) {
    const server = createMcpServer(cdp as CdpClient, "all", true);
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as Reply;
    return { client, call };
  }

  it("the handshake opens with the install note", async () => {
    const { client } = await connect();
    assert.match(client.getInstructions()!, /^BrowserDo first downloads and installs the Embiody browser/);
    await client.close();
  });

  it("a browser tool replies with the progress as an error, doing nothing", async () => {
    setInstallStatus({ phase: "installing" });
    const { client, call } = await connect();
    const reply = await call("browser_get_window_info");
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /being installed.*Nothing was done/);
    await client.close();
  });

  it("browser_status reports the progress, not as an error, and a failure retries the install", async () => {
    let retries = 0;
    onInstallRetry(() => retries++);
    setInstallStatus({ phase: "failed", error: "cnb: HTTP 503" });
    const { client, call } = await connect();
    const reply = await call("browser_status");
    assert.ok(!reply.isError);
    assert.match(reply.content[0].text, /failed: cnb: HTTP 503/);
    await call("browser_click", { emsn: 1, snapshotId: "x" });
    assert.equal(retries, 2, "each call while it stays failed retries once");
    await client.close();
  });

  it("browser_stop_task still runs: it needs no browser", async () => {
    setInstallStatus({ phase: "installing" });
    const { client, call } = await connect();
    assert.match((await call("browser_stop_task", { taskId: "none" })).content[0].text, /does not exist/);
    await client.close();
  });

  it("once installed, browser_status says ready, or what is wrong with the browser", async () => {
    let s = await connect({ isConnected: true, versionProblem: null });
    assert.equal((await s.call("browser_status")).content[0].text, "The Embiody browser is ready.");
    await s.client.close();
    s = await connect({ isConnected: true, versionProblem: "This Embiody is 0.9.0.1; BrowserDo needs 0.9.0.3 or newer." });
    assert.match((await s.call("browser_status")).content[0].text, /needs 0\.9\.0\.3/);
    await s.client.close();
  });
});
