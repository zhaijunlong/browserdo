import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// Keep the debug log out of the real one. Read once when config.ts loads.
process.env.EMBIODY_DEBUG_LOG = path.join(os.tmpdir(), "browserdo-test", String(process.pid), "debug.log");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = await import("../../src/server.js");
import type { CdpClient } from "../../src/cdp-client.js";

type Reply = { content: Array<{ text: string }>; isError?: boolean };

/** Through the MCP SDK as a client calls: a misspelt parameter name is refused, not dropped. */
describe("unknown parameter names", () => {
  async function connect() {
    // {} as CdpClient: a tool that got as far as the browser would fail on it.
    const server = createMcpServer({ isConnected: false, versionProblem: null } as unknown as CdpClient, "all");
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Reply;
    return { client, call };
  }

  it("refuses the call, doing nothing, and lists what the tool takes", async () => {
    const { client, call } = await connect();
    const started = Date.now();
    const reply = await call("browser_wait", { ms: 300 });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /unknown parameter "ms"; browser_wait takes windowId, tabId, durationMs/);
    assert.ok(Date.now() - started < 1000, "it must not have waited the default 2 s");
    assert.match((await call("browser_wait", { durationMs: 100 })).content[0].text, /Waited 100ms/);
    await client.close();
  });

  it("covers a tool with no parameters and browser_run_task, registered apart", async () => {
    const { client, call } = await connect();
    assert.match((await call("browser_status", { verbose: true })).content[0].text, /"verbose"; browser_status takes no parameters/);
    assert.match((await call("browser_run_task", { task: "x", taskId: "y" })).content[0].text, /unknown parameter "taskId"; browser_run_task takes task/);
    await client.close();
  });

  it("tools/list still says no other parameters are allowed", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const wait = tools.find((t) => t.name === "browser_wait")!;
    assert.deepEqual(Object.keys(wait.inputSchema.properties ?? {}), ["windowId", "tabId", "durationMs", "forText", "gone", "timeoutMs"]);
    assert.equal((wait.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);
    await client.close();
  });
});
