import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import { describe, it } from "node:test";
import http from "node:http";
import express from "express";
import type { CdpClient } from "../../src/cdp-client.js";
import { createSseApp, listenSse } from "../../src/server.js";

/**
 * The SSE endpoint has no authentication, so neither another machine on the network nor a web
 * page open in the user's browser (directly or through DNS rebinding) may reach it.
 */

/** POST to /messages with chosen Host and Origin; past the guards it answers 400 (no such session). */
function post(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/messages?sessionId=none", headers: { "Content-Type": "application/json", ...headers } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.once("error", reject);
    req.end("{}");
  });
}

describe("who may call the SSE server", () => {
  it("refuses a foreign Origin or Host, lets local ones and requests without Origin through", async (t) => {
    const server = listenSse(createSseApp({} as CdpClient, "browser"), 0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    t.after(() => server.close());
    const { port } = server.address() as AddressInfo;
    const host = `127.0.0.1:${port}`;

    assert.equal(await post(port, { Host: host }), 400, "no Origin (a command-line client)");
    for (const origin of ["http://localhost:6274", "http://127.0.0.1", "https://[::1]:8080"]) {
      assert.equal(await post(port, { Host: host, Origin: origin }), 400, origin);
    }
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "file://localhost"]) {
      assert.equal(await post(port, { Host: host, Origin: origin }), 403, origin);
    }
    assert.equal(await post(port, { Host: `evil.example:${port}` }), 403, "rebound Host");
    assert.equal(await post(port, { Host: `localhost:${port}` }), 400, "localhost Host");
  });
});

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 500 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

describe("the SSE server's address", () => {
  it("listens on loopback only, not on this machine's network addresses", async (t) => {
    const server = listenSse(express(), 0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    t.after(() => server.close());
    const { address, port } = server.address() as AddressInfo;
    assert.equal(address, "127.0.0.1");
    assert.equal(await connects("127.0.0.1", port), true);

    const lanAddresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal && a.family === "IPv4")
      .map((a) => a!.address);
    for (const lan of lanAddresses) {
      assert.equal(await connects(lan, port), false, `reachable on ${lan}`);
    }
  });
});
