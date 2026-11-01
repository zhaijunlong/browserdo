import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { downloadInstaller } from "../../src/embiody-browser.js";
import { installProgress, setInstallStatus } from "../../src/install_status.js";
import {
  EMBIODY_GITHUB_DOWNLOAD_BASE,
  EMBIODY_INSTALLER_NAME,
  EMBIODY_RELEASES_PAGE_URL,
} from "../../src/config.js";

/** GitHub is the main installer source and cnb the fallback; every GitHub failure must reach cnb. */

const GITHUB_EXE = Buffer.from("installer from github");
const CNB_EXE = Buffer.from("installer from cnb");
const CNB_DIR = "https://cnb.example/download/v1";
const CNB_EXE_URL = `${CNB_DIR}/${EMBIODY_INSTALLER_NAME}`;
const CNB_SUMS_URL = `${CNB_DIR}/SHA256SUMS.txt`;
/** Another channel's installer, published in the same release. */
const OTHER_CHANNEL_URL = `${CNB_DIR}/EmbiodySetup-Offline-OTHER.exe`;
const SUMS_URL = `${EMBIODY_GITHUB_DOWNLOAD_BASE}/SHA256SUMS.txt`;
const GITHUB_EXE_URL = `${EMBIODY_GITHUB_DOWNLOAD_BASE}/${EMBIODY_INSTALLER_NAME}`;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const goodSums = `${sha256(Buffer.from("other"))}  EmbiodyBrowserUpdate-1.crx3\n${sha256(GITHUB_EXE)}  ${EMBIODY_INSTALLER_NAME}\n`;

type Route = Buffer | string | number | Error | ((signal?: AbortSignal) => Response);

/** A body that sends size bytes in chunks of chunk every everyMs, then stalls; it ends when the request is aborted. */
function trickle(size: number, chunk: number, everyMs: number, chunks: number) {
  return (signal?: AbortSignal) => {
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        let sent = 0;
        timer = setInterval(() => {
          if (sent++ < chunks) c.enqueue(new Uint8Array(chunk));
        }, everyMs);
        signal?.addEventListener("abort", () => {
          clearInterval(timer);
          c.error(signal.reason);
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return new Response(body, { headers: { "content-length": String(size) } });
  };
}

describe("downloading the installer", () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let dest: string;
  let requested: string[];

  function serve(routes: Record<string, Route>): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (route instanceof Error) throw route;
      if (typeof route === "function") return route(init?.signal ?? undefined);
      if (route === undefined || typeof route === "number") {
        return new Response("", { status: route ?? 404 });
      }
      return new Response(typeof route === "string" ? route : new Uint8Array(route));
    }) as typeof fetch;
  }

  const cnbSums = (exe: Buffer) =>
    `${sha256(Buffer.from("x"))}  EmbiodySetup-Offline-OTHER.exe\n${sha256(exe)}  ${EMBIODY_INSTALLER_NAME}\n`;
  const latest = (url: string) => `<html>"body":"latest=${url}\\n"</html>`;
  const cnbRoutes: Record<string, Route> = {
    [EMBIODY_RELEASES_PAGE_URL]: latest(CNB_EXE_URL),
    [CNB_SUMS_URL]: cnbSums(CNB_EXE),
    [CNB_EXE_URL]: CNB_EXE,
    [OTHER_CHANNEL_URL]: Buffer.from("another channel"),
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "browserdo-dl-"));
    dest = path.join(dir, "setup.exe");
    requested = [];
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    setInstallStatus({ phase: "idle" });
    await rm(dir, { recursive: true, force: true });
  });

  it("takes GitHub's installer when its checksum matches, without touching cnb", async () => {
    serve({ [SUMS_URL]: goodSums, [GITHUB_EXE_URL]: GITHUB_EXE, ...cnbRoutes });
    assert.equal(await downloadInstaller(dest), "github");
    assert.deepEqual(await readFile(dest), GITHUB_EXE);
    assert.ok(!requested.some((u) => u.includes("cnb")));
  });

  const failures: Array<[string, Record<string, Route>]> = [
    ["the installer is a 404", { [SUMS_URL]: goodSums, [GITHUB_EXE_URL]: 404 }],
    ["the network fails", { [SUMS_URL]: new TypeError("fetch failed") }],
    ["the checksum does not match", { [SUMS_URL]: goodSums, [GITHUB_EXE_URL]: Buffer.from("tampered") }],
    ["SHA256SUMS.txt has no line for the installer", { [SUMS_URL]: "abc  other.exe\n", [GITHUB_EXE_URL]: GITHUB_EXE }],
  ];
  for (const [name, github] of failures) {
    it(`falls back to cnb when ${name}`, async () => {
      serve({ ...github, ...cnbRoutes });
      assert.equal(await downloadInstaller(dest), "cnb");
      assert.deepEqual(await readFile(dest), CNB_EXE);
    });
  }

  it("takes this channel's installer from cnb when latest= names another channel's", async () => {
    serve({ [SUMS_URL]: 404, ...cnbRoutes, [EMBIODY_RELEASES_PAGE_URL]: latest(OTHER_CHANNEL_URL) });
    assert.equal(await downloadInstaller(dest), "cnb");
    assert.deepEqual(await readFile(dest), CNB_EXE);
  });

  it("refuses cnb's installer when its checksum does not match", async () => {
    serve({ [SUMS_URL]: 404, ...cnbRoutes, [CNB_EXE_URL]: Buffer.from("tampered") });
    await assert.rejects(downloadInstaller(dest), /cnb: .*Checksum mismatch/);
  });

  it("names both failures when cnb fails too", async () => {
    serve({ [SUMS_URL]: 404, [EMBIODY_RELEASES_PAGE_URL]: 503 });
    await assert.rejects(downloadInstaller(dest), /GitHub: .*404.*; cnb: .*503/);
  });

  it("falls back to cnb when GitHub stops sending", async () => {
    serve({ [SUMS_URL]: goodSums, [GITHUB_EXE_URL]: trickle(1000, 10, 5, 1), ...cnbRoutes });
    const limits = { stallMs: 100, slowCheckMs: 60_000, slowTotalMs: 600_000 };
    assert.equal(await downloadInstaller(dest, limits), "cnb");
    assert.deepEqual(await readFile(dest), CNB_EXE);
  });

  it("falls back to cnb when GitHub would take too long, judged only after slowCheckMs", async () => {
    // 10 bytes every 10 ms of 1 MB: about 17 minutes in all, against a limit of 1 s.
    serve({ [SUMS_URL]: goodSums, [GITHUB_EXE_URL]: trickle(1_000_000, 10, 10, Infinity), ...cnbRoutes });
    const started = Date.now();
    assert.equal(await downloadInstaller(dest, { stallMs: 1000, slowCheckMs: 100, slowTotalMs: 1000 }), "cnb");
    assert.ok(Date.now() - started >= 100, "not judged before slowCheckMs");
  });

  it("reports the download's source and progress in the install status", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024);
    serve({ [SUMS_URL]: 404, ...cnbRoutes, [CNB_SUMS_URL]: cnbSums(big), [CNB_EXE_URL]: big });
    await downloadInstaller(dest);
    assert.match(installProgress()!, /from cnb \(3 (of 3 MB|MB so far)/);
  });
});
