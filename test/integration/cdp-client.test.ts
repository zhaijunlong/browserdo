import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, afterEach } from "node:test";
import { WebSocketServer } from "ws";
import { MIN_EMBIODY_VERSION } from "../../src/browser_version.js";
import { CdpClient } from "../../src/cdp-client.js";

/**
 * Finding the browser again after it restarts on a new port. A client that only remembered the
 * first port retried a dead one until the person ran /mcp reconnect (2026-09-28).
 */

/**
 * A stand-in browser: /json/version names its socket and version (null: no version), and every
 * command is answered (by answer, when given; null sends nothing). seen lists every method received.
 */
async function fakeBrowser(
  answer?: (msg: { id: number; method: string }) => object | null,
  browser: string | null = `Chrome/156.0.8078.12 Embiody/${MIN_EMBIODY_VERSION}`,
) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    res.end(JSON.stringify({ Browser: browser ?? undefined, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      seen.push(msg.method);
      const out = answer ? answer(msg) : { id: msg.id, result: { method: msg.method } };
      if (out) ws.send(JSON.stringify(out));
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => wss.clients.size,
    seen,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    },
  };
}

type Fake = Awaited<ReturnType<typeof fakeBrowser>>;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(ok(), "timed out waiting");
};

describe("CdpClient: finding the browser again", () => {
  const open: Fake[] = [];
  const clients: CdpClient[] = [];
  const browser = async (answer?: Parameters<typeof fakeBrowser>[0]) => {
    const b = await fakeBrowser(answer);
    open.push(b);
    return b;
  };
  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const b of open.splice(0)) await b.close();
  });

  it("a command after the browser went away starts it again, once for commands arriving together", async () => {
    const first = await browser();
    let started = 0;
    const client = new CdpClient("127.0.0.1", first.port, {
      currentPort: () => null,
      ensureRunning: async () => {
        started++;
        return (await browser()).port;
      },
    });
    clients.push(client);
    await client.connect();
    await first.close();
    await until(() => !client.isConnected);

    const replies = await Promise.all([1, 2, 3].map((n) => client.sendCommand(`Test.m${n}`)));
    assert.deepEqual(replies.map((r) => r.method), ["Test.m1", "Test.m2", "Test.m3"]);
    assert.equal(started, 1);
  });

  it("the background retry reads the new port but never starts a browser", async () => {
    const first = await browser();
    const second = await browser();
    let started = 0;
    const client = new CdpClient("127.0.0.1", first.port, {
      currentPort: () => second.port,
      ensureRunning: async () => {
        started++;
        return second.port;
      },
    });
    clients.push(client);
    await client.connect();
    await first.close();
    await until(() => !client.isConnected);

    client.connectWithRetry();
    await until(() => client.isConnected);
    assert.equal(second.connections(), 1);
    assert.equal(started, 0);
  });

  it("when the browser cannot be brought back, the error says why", async () => {
    const first = await browser();
    const client = new CdpClient("127.0.0.1", first.port, {
      currentPort: () => null,
      ensureRunning: async () => {
        throw new Error("Embiody is not installed");
      },
    });
    clients.push(client);
    await client.connect();
    await first.close();
    await until(() => !client.isConnected);
    await assert.rejects(client.sendCommand("Test.m"), /CDP not connected: Embiody is not installed/);
  });

  it("a second socket opening while connected is dropped without taking the live one down", async () => {
    const b = await browser();
    const client = new CdpClient("127.0.0.1", b.port);
    clients.push(client);
    await client.connect();
    await client.connect(); // what a background retry racing a recovery does
    await until(() => b.connections() === 1);
    assert.ok(client.isConnected);
    assert.equal((await client.sendCommand("Test.still")).method, "Test.still");
  });

  it("without rediscovery, a lost connection is reported as before", async () => {
    const b = await browser();
    const client = new CdpClient("127.0.0.1", b.port);
    clients.push(client);
    await client.connect();
    await b.close();
    await until(() => !client.isConnected);
    await assert.rejects(client.sendCommand("Test.m"), /^Error: CDP not connected$/);
  });
});

describe("CdpClient: replies", () => {
  const open: Fake[] = [];
  const clients: CdpClient[] = [];
  const connected = async (answer: Parameters<typeof fakeBrowser>[0]) => {
    const b = await fakeBrowser(answer);
    open.push(b);
    const client = new CdpClient("127.0.0.1", b.port);
    clients.push(client);
    await client.connect();
    return { b, client };
  };
  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const b of open.splice(0)) await b.close();
  });

  it("an error reply carries data, where Invalid parameters says which one", async () => {
    const { client } = await connected(({ id }) => ({
      id,
      error: { code: -32602, message: "Invalid parameters", data: "Failed to deserialize params.tabId" },
    }));
    await assert.rejects(client.sendCommand("Test.m"), /^Error: Invalid parameters: Failed to deserialize params.tabId$/);
  });

  it("an error reply without data or message still rejects", async () => {
    const { client } = await connected(({ id }) => ({ id, error: {} }));
    await assert.rejects(client.sendCommand("Test.m"), /^Error: CDP error$/);
  });

  it("a command never answered fails at its own timeout", async () => {
    const { client } = await connected(() => null);
    await assert.rejects(client.sendCommand("Test.silent", {}, 50), /CDP command timeout: Test.silent/);
  });

  it("commands in flight are rejected when the connection drops", async () => {
    const { b, client } = await connected(() => null);
    const rejected = assert.rejects(client.sendCommand("Test.inflight"), /CDP connection closed/);
    await b.close();
    await rejected;
  });

  it("a message with a method and no id goes to the event handler", async () => {
    const { client } = await connected(({ id, method }) =>
      method === "Test.emit" ? { method: "Test.event", params: { n: 1 } } : { id, result: {} },
    );
    const seen: Array<[string, unknown]> = [];
    client.onEvent((method, params) => seen.push([method, params]));
    void client.sendCommand("Test.emit", {}, 1000).catch(() => {});
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], ["Test.event", { n: 1 }]);
  });
});

describe("CdpClient: the browser must be new enough", () => {
  const open: Fake[] = [];
  const clients: CdpClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect();
    for (const b of open.splice(0)) await b.close();
  });
  const connectTo = async (browser: string | null) => {
    const b = await fakeBrowser(undefined, browser);
    open.push(b);
    const client = new CdpClient("127.0.0.1", b.port);
    clients.push(client);
    await client.connect();
    return { b, client };
  };

  it("a new enough browser gets the command", async () => {
    const { b, client } = await connectTo(`Chrome/156.0.8078.12 Embiody/${MIN_EMBIODY_VERSION}`);
    await client.sendCommand("Embiody.browserGetWindowInfo");
    assert.deepEqual(b.seen, ["Embiody.browserGetWindowInfo"]);
  });

  it("a browser too old: no command goes through, and its update page opens once", async () => {
    const { b, client } = await connectTo("Chrome/156.0.8078.12 Embiody/0.9.0.2");
    for (let i = 0; i < 2; i++) {
      await assert.rejects(client.sendCommand("Embiody.browserGetWindowInfo"), {
        name: "BrowserVersionError",
        message: /0\.9\.0\.3.*chrome:\/\/settings\/help/,
      });
    }
    assert.deepEqual(b.seen, ["Target.createTarget"]);
  });

  it("a version that cannot be read: refused, and no update page", async () => {
    const { b, client } = await connectTo(null);
    await assert.rejects(client.sendCommand("Embiody.browserGetWindowInfo"), /Could not read the Embiody version/);
    assert.deepEqual(b.seen, []);
  });

  it("checked again on reconnecting: the updated, restarted browser gets commands", async () => {
    const old = await fakeBrowser(undefined, "Chrome/156.0.8078.12 Embiody/0.9.0.2");
    open.push(old);
    let updated: Fake | undefined;
    const client = new CdpClient("127.0.0.1", old.port, {
      currentPort: () => null,
      ensureRunning: async () => {
        updated = await fakeBrowser(undefined, `Chrome/156.0.8078.12 Embiody/${MIN_EMBIODY_VERSION}`);
        open.push(updated);
        return updated.port;
      },
    });
    clients.push(client);
    await client.connect();
    await assert.rejects(client.sendCommand("Embiody.browserGetWindowInfo"), { name: "BrowserVersionError" });

    await old.close();
    await until(() => !client.isConnected);
    await client.sendCommand("Embiody.browserGetWindowInfo");
    assert.deepEqual(updated!.seen, ["Embiody.browserGetWindowInfo"]);
  });
});
