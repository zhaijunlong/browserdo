import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CdpClient } from "./cdp-client.js";
import { browserGetWindowInfo } from "./browser-actions.js";
import type { WindowInfo } from "./runtime_types.js";
import {
  CDP_DEFAULT_HOST,
  EMBIODY_APP_PATHS_KEYS,
  EMBIODY_GITHUB_DOWNLOAD_BASE,
  EMBIODY_INSTALLER_NAME,
  EMBIODY_PROFILE_BASELINE,
  EMBIODY_RELEASES_PAGE_URL,
  EMBIODY_RESET_PROFILE,
  EMBIODY_USER_DATA_DIR,
  SHARED_PROFILE,
} from "./config.js";
import { acquireInstallLock, readInstallLock } from "./install_lock.js";
import { noteInstalled } from "./install_notice.js";
import { getInstallStatus, onInstallRecheck, setInstallStatus, type InstallStatus } from "./install_status.js";
import { appendDebugLog } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Default flags for launching Embiody: the smallest safe set for "visible, real browsing".
 * Keep headless/CI flags out (--disable-background-networking, the site-isolation entries of
 * --disable-features, --no-sandbox and so on): they break real page loads — typically the home
 * page opens while a heavier results page hangs on a white screen.
 * To check whether a particular flag is the culprit, override the whole list with the
 * EMBIODY_LAUNCH_FLAGS environment variable (space separated).
 */
const BASE_LAUNCH_FLAGS = [
  // Embiody-specific
  "--allow-pre-commit-input", // enable pre-commit input emulation
  // Suppress first-run and promotional prompts
  "--no-first-run", // skip the first-run wizard
  "--hide-crash-restore-bubble", // no "restore last session" prompt
  "--no-default-browser-check", // no "make default browser / choose Chrome" prompt
  "--disable-search-engine-choice-screen", // skip the EU search-engine choice screen
  "--disable-popup-blocking", // some sites need popups for sign-in or payment
  "--disable-prompt-on-repost", // no "resubmit form" confirmation
  // Credentials and reporting
  "--password-store=basic", // avoid keychain prompts (this and the next are Linux / macOS flags)
  "--use-mock-keychain",
  "--disable-breakpad", // no crash reporting
  "--metrics-recording-only",
  // Stability for visible browsing (verified not to break page loads)
  "--disable-renderer-backgrounding", // keep render priority when not in front, so pages keep loading
  "--disable-backgrounding-occluded-windows", // full speed when covered by other windows, keeping snapshots and loads stable
  "--disable-features=Translate", // no translate bar to cover or mis-click
  "--force-color-profile=srgb", // consistent screenshot colour, easier for the VLM
  // Not --disable-blink-features=AutomationControlled: it shows the "unsupported command-line
  // flag" bar, which pushes the viewport down so snapshot boxes no longer line up with click
  // coordinates. Not needed either: navigator.webdriver is false however the browser is
  // launched (a browser change of late September 2026).
];

/**
 * The launch command line: BASE_LAUNCH_FLAGS (or EMBIODY_LAUNCH_FLAGS in their place), then
 * EMBIODY_EXTRA_FLAGS, then the core arguments (user-data-dir, start maximized, remote
 * debugging port 0, about:blank last), which neither variable can drop.
 */
export function buildLaunchArgs(): string[] {
  const coreArgs = [
    `--user-data-dir=${EMBIODY_USER_DATA_DIR}`,
    "--start-maximized",
    "--remote-debugging-port=0",
    "about:blank",
  ];
  const override = process.env.EMBIODY_LAUNCH_FLAGS?.trim();
  const flags = override
    ? override.split(/\s+/).filter(Boolean)
    : BASE_LAUNCH_FLAGS;
  // extraFlags are appended after the defaults rather than replacing them, for things like --no-sandbox
  const extra = process.env.EMBIODY_EXTRA_FLAGS?.trim();
  const extraFlags = extra ? extra.split(/\s+/).filter(Boolean) : [];
  return [...flags, ...extraFlags, ...coreArgs];
}

/**
 * Starting the person's own browser: as a double-click would, plus the Default profile, so it
 * opens that profile rather than the last used one or the profile picker. Their browser opens
 * CDP on its own (always-on CDP); our flags would change how their browser behaves, and are
 * ignored anyway when it is already running.
 */
export const SHARED_LAUNCH_ARGS = ["--profile-directory=Default"];

/**
 * The installed embiody.exe from its App Paths entry, or null when there is none or it points at
 * a file that is gone. Every install and update writes the entry and only uninstalling removes it
 * (setup's install.cc, shell_util.cc, uninstall.cc).
 * Not the updater's InstallerSuccessLaunchCmdLine: a one-shot hand-over the updater renames once
 * it has launched the browser. Stops holding if Beta/Dev channels ship: their exe is also
 * embiody.exe, so their entries would overwrite each other.
 */
export async function getInstalledExePath(): Promise<string | null> {
  for (const key of EMBIODY_APP_PATHS_KEYS) {
    let exePath: string | undefined;
    try {
      const { stdout } = await execFileAsync("reg", ["query", key, "/ve"]);
      exePath = stdout.match(/REG_SZ\s+(.+)/)?.[1].replace(/"/g, "").trim();
    } catch {
      continue; // No such key.
    }
    if (!exePath) continue;
    if (existsSync(exePath)) return exePath;
    // An update made while the browser was open moves new_embiody.exe over embiody.exe as it
    // exits, leaving no file for a few milliseconds; taking that for "not installed" would reinstall.
    await sleep(500);
    if (existsSync(exePath)) return exePath;
  }
  return null;
}

/** Parse the latest installer download URL from the `latest=<url>` line in the release page Overview. */
export async function resolveLatestInstallerUrl(): Promise<string> {
  const resp = await fetch(EMBIODY_RELEASES_PAGE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`Could not read the releases page: HTTP ${resp.status}`);
  }
  const html = await resp.text();
  // The release page serialises the Overview body into JSON ("body":"latest=<url>..."), so match loosely for the .exe URL.
  const match = html.match(/latest=(https?:\/\/[^\s"'<>=]+\.exe)/);
  if (!match) {
    throw new Error("Could not find a latest= download URL on the releases page");
  }
  return match[1];
}

type OnProgress = (received: number, total: number | null) => void;

/** When a download is given up: so a stalled or crawling GitHub falls back to cnb instead of taking an hour. */
export interface DownloadLimits {
  /** No data for this long. */
  stallMs: number;
  /** For GitHub only: once this long in, give up if the whole file would take longer than slowTotalMs. */
  slowCheckMs: number;
  slowTotalMs: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = {
  stallMs: 30_000,
  slowCheckMs: 60_000,
  slowTotalMs: 10 * 60_000,
};

async function fetchBytes(
  url: string,
  limits: DownloadLimits,
  onProgress?: OnProgress,
  giveUpIfSlow = false,
): Promise<Buffer> {
  const controller = new AbortController();
  let why = "";
  let stall: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => {
    why = reason;
    controller.abort();
  };
  const rearm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => stop(`no data for ${limits.stallMs / 1000} s`), limits.stallMs);
  };
  rearm();
  const startedAt = Date.now();
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Downloading ${url} failed: HTTP ${resp.status}`);
    }
    if (!onProgress || !resp.body) {
      return Buffer.from(await resp.arrayBuffer());
    }
    const total = Number(resp.headers.get("content-length")) || null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of resp.body) {
      rearm();
      chunks.push(chunk);
      received += chunk.length;
      onProgress(received, total);
      const elapsed = Date.now() - startedAt;
      if (giveUpIfSlow && total && elapsed >= limits.slowCheckMs && (elapsed * total) / received > limits.slowTotalMs) {
        stop(`too slow (${Math.round(received / 1024 / (elapsed / 1000))} KB/s)`);
      }
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (why) throw new Error(`Downloading ${url} stopped: ${why}`);
    throw error;
  } finally {
    clearTimeout(stall);
  }
}

/** Report a download from source in the install status; returns the progress callback. */
function trackDownload(source: "GitHub" | "cnb"): OnProgress {
  const startedAt = Date.now();
  const report: OnProgress = (received, total) =>
    setInstallStatus({ phase: "downloading", source, received, total, startedAt });
  report(0, null);
  return report;
}

/**
 * Download EMBIODY_INSTALLER_NAME from a release folder and write it only once its SHA-256
 * matches the folder's SHA256SUMS.txt.
 */
async function downloadVerified(
  base: string,
  dest: string,
  limits: DownloadLimits,
  onProgress: OnProgress,
  giveUpIfSlow: boolean,
): Promise<void> {
  await appendDebugLog("embiody_browser", "downloading installer", { url: `${base}/${EMBIODY_INSTALLER_NAME}` });
  const sums = (await fetchBytes(`${base}/SHA256SUMS.txt`, limits)).toString("utf8");
  const line = sums
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+\*?/))
    .find((parts) => parts[1] === EMBIODY_INSTALLER_NAME);
  const expected = line?.[0]?.toLowerCase();
  if (!expected) {
    throw new Error(`SHA256SUMS.txt has no line for ${EMBIODY_INSTALLER_NAME}`);
  }
  const buffer = await fetchBytes(`${base}/${EMBIODY_INSTALLER_NAME}`, limits, onProgress, giveUpIfSlow);
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
  await appendDebugLog("embiody_browser", "installer checksum verified", { sha256: actual });
  await writeFile(dest, buffer);
}

/**
 * Download the newest installer to dest: GitHub first; on any failure there (network error,
 * HTTP error, checksum mismatch, stalled or too slow) fall back to the same file in cnb's newest
 * release. Returns the source it came from.
 */
export async function downloadInstaller(
  dest: string,
  limits: DownloadLimits = DOWNLOAD_LIMITS,
): Promise<"github" | "cnb"> {
  let githubError: unknown;
  try {
    await downloadVerified(EMBIODY_GITHUB_DOWNLOAD_BASE, dest, limits, trackDownload("GitHub"), true);
    return "github";
  } catch (err) {
    githubError = err;
    await appendDebugLog("embiody_browser", "GitHub download failed, trying cnb", {
      error: String(err),
    });
  }
  try {
    const onProgress = trackDownload("cnb");
    // latest= may name another channel's installer; only its release folder is taken from it.
    const url = await resolveLatestInstallerUrl();
    await downloadVerified(url.slice(0, url.lastIndexOf("/")), dest, limits, onProgress, false);
    return "cnb";
  } catch (err) {
    throw new Error(
      `Downloading the installer failed. GitHub: ${String(githubError)}; cnb: ${String(err)}`,
    );
  }
}

/**
 * Run the installer silently; do not wait for its child processes. Without --silent it shows a
 * progress window and then opens the browser on the person's own profile (the browser's
 * installer documentation).
 */
async function runInstaller(installerPath: string): Promise<void> {
  try {
    await execFileAsync(installerPath, ["--silent"], { windowsHide: true, timeout: INSTALL_TIMEOUT_MS });
  } catch (error) {
    // execFile kills it at the timeout; say so rather than "Command failed".
    if ((error as { killed?: boolean }).killed) {
      throw new Error(`The installer did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes`);
    }
    throw error;
  }
}

/** A stuck installer is given up on after this long, so the install fails and the next call retries it. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/** Poll the registry until the install is detected or we time out; returns the exe path or null. */
async function waitForInstall(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exePath = await getInstalledExePath();
    if (exePath) {
      return exePath;
    }
    await sleep(2_000);
  }
  return null;
}

/**
 * Install Embiody unless another BrowserDo process is installing it, in which case wait for that
 * one; returns the exe path. If the other one ends without a browser, this one tries.
 */
async function installEmbiody(): Promise<string> {
  let waiting = false;
  for (;;) {
    const lock = await acquireInstallLock(() => JSON.stringify(getInstallStatus()));
    if (lock) {
      try {
        return (await getInstalledExePath()) ?? (await downloadAndInstall());
      } finally {
        lock.release();
      }
    }
    if (!waiting) {
      waiting = true;
      await appendDebugLog("embiody_browser", "another BrowserDo is installing Embiody; waiting");
    }
    setInstallStatus(holderProgress(await readInstallLock()));
    await sleep(2_000);
    const exePath = await getInstalledExePath();
    if (exePath) {
      await appendDebugLog("embiody_browser", "installed by another BrowserDo", { exePath });
      noteInstalled();
      return exePath;
    }
  }
}

/** The install status to show while another process installs: its own progress, when it sends one. */
function holderProgress(sent: string | null): InstallStatus {
  try {
    const status = JSON.parse(sent ?? "") as InstallStatus;
    if (status.phase === "downloading" || status.phase === "installing") return status;
  } catch {
    // An older BrowserDo sends nothing.
  }
  return { phase: "elsewhere" };
}

/** Download and silently install Embiody, returning the exe path; the install status follows each step. */
async function downloadAndInstall(): Promise<string> {
  const installerPath = path.join(
    os.tmpdir(),
    `embiody_installer_${Date.now()}.exe`,
  );
  let exePath: string | null;
  try {
    const source = await downloadInstaller(installerPath);
    await appendDebugLog("embiody_browser", "installer downloaded", { source });

    setInstallStatus({ phase: "installing" });
    await appendDebugLog("embiody_browser", "running silent install", { installerPath });
    try {
      await runInstaller(installerPath);
    } finally {
      // The temp file can go once the installer has run.
      void safeUnlink(installerPath);
    }

    exePath = await waitForInstall(120_000);
    if (!exePath) {
      throw new Error("Embiody is still not in the registry after installing");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setInstallStatus({ phase: "failed", error: message });
    await appendDebugLog("embiody_browser", "install failed", { error: message });
    throw error;
  }
  await appendDebugLog("embiody_browser", "install finished", { exePath });
  noteInstalled();
  return exePath;
}

/**
 * The browser's debugging port from the files it writes in the user data folder, or null.
 * EmbiodyAgentPort first: its third line is the browser's pid, which tells a live file from one
 * a crash left behind. DevToolsActivePort (port only) covers the moments before the browser
 * writes EmbiodyAgentPort (up to 10 s after start) and builds that do not write it.
 */
export function readExistingPort(dir: string = EMBIODY_USER_DATA_DIR): number | null {
  const agent = readPortFile(path.join(dir, "EmbiodyAgentPort"));
  if (agent) {
    return agent.pid && !isProcessAlive(agent.pid) ? null : agent.port;
  }
  return readPortFile(path.join(dir, "DevToolsActivePort"))?.port ?? null;
}

function readPortFile(file: string): { port: number; pid: number | null } | null {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const port = Number(lines[0]?.trim());
    if (!Number.isInteger(port) || port <= 0) return null;
    const pid = Number(lines[2]?.trim());
    return { port, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Probe whether a CDP service answers on the port, to tell whether the process is really running. */
async function isPortAlive(port: number): Promise<boolean> {
  try {
    const resp = await fetch(
      `http://${CDP_DEFAULT_HOST}:${port}/json/version`,
      { signal: AbortSignal.timeout(1_500) },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/** Start the exe detached: non-blocking, and not killed when Node exits. */
function launchExe(exePath: string): void {
  const args = SHARED_PROFILE ? SHARED_LAUNCH_ARGS : buildLaunchArgs();
  // Launched through `cmd /c start` so the browser leaves the current console process group.
  // Ctrl+C on the terminal then stops Node without taking the browser with it, which keeps
  // the scene intact for debugging. (A plain spawn, even with detached:true, still receives
  // Ctrl+C in a Windows console.)
  const child = spawn(
    "cmd",
    ["/c", "start", '""', exePath, ...args],
    { stdio: "ignore", windowsHide: true },
  );
  child.unref();
}

/** Poll until a port file appears and the port answers; returns the port. */
async function waitForPort(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readExistingPort();
    if (port && (await isPortAlive(port))) {
      return port;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for the Embiody debugging port (${timeoutMs}ms)` +
      // The person's browser opens it by itself unless a policy turns it off.
      (SHARED_PROFILE ? "; if Embiody is open, the RemoteDebuggingAllowed policy may have turned it off" : ""),
  );
}

/**
 * Reset the profile to a fixed starting state (only when `browser.resetProfile` is on).
 *
 * **This must happen before we reuse a running browser**, or the one we reuse still carries
 * the previous run's leftovers.
 *
 * When a browser already holds this profile we **fail rather than kill it**: the directory is
 * in use and cannot be cleaned, and that window may be one a person is looking at. The error
 * spells out the two ways forward.
 */
export async function resetUserDataDir(): Promise<void> {
  if (!EMBIODY_RESET_PROFILE) return;
  if (SHARED_PROFILE) {
    throw new Error(
      `browser.resetProfile would delete the person's own Embiody profile (${EMBIODY_USER_DATA_DIR}). ` +
        `It works only on a separate profile: set browser.userDataDir to a folder of its own.`,
    );
  }

  const port = readExistingPort();
  if (port && (await isPortAlive(port))) {
    throw new Error(
      `browser.resetProfile is on, but a browser is already using this profile ` +
        `(${EMBIODY_USER_DATA_DIR}, port ${port}). The directory cannot be cleared while it is ` +
        `in use. Close that window first, or point browser.userDataDir somewhere else.`,
    );
  }

  await rm(EMBIODY_USER_DATA_DIR, { recursive: true, force: true });
  if (EMBIODY_PROFILE_BASELINE) {
    if (!existsSync(EMBIODY_PROFILE_BASELINE)) {
      throw new Error(
        `browser.profileBaseline points at a directory that does not exist: ` +
          `${EMBIODY_PROFILE_BASELINE}. Save one first with scripts/save-profile-baseline.mjs.`,
      );
    }
    await cp(EMBIODY_PROFILE_BASELINE, EMBIODY_USER_DATA_DIR, { recursive: true });
  }
  await appendDebugLog("embiody_browser", "profile reset", {
    userDataDir: EMBIODY_USER_DATA_DIR,
    baseline: EMBIODY_PROFILE_BASELINE ?? "(none; starting from a fresh profile)",
  });
}

/** Whether there is a browser to start without installing one: a configured exe, or an installed Embiody. */
export async function isEmbiodyInstalled(): Promise<boolean> {
  return Boolean(process.env.EMBIODY_EXE_PATH?.trim()) || (await getInstalledExePath()) !== null;
}

let installing: Promise<string> | null = null;

/**
 * Make sure there is a browser to start, installing Embiody if need be, and return its exe path.
 * Never starts the browser. Concurrent callers (startup, a launch, an install retry) share one
 * attempt, so nothing installs twice.
 */
export function ensureEmbiodyInstalled(): Promise<string> {
  installing ??= findOrInstallExe().finally(() => {
    installing = null;
  });
  return installing;
}

async function findOrInstallExe(): Promise<string> {
  let exePath: string;
  const customExePath = process.env.EMBIODY_EXE_PATH?.trim();
  if (customExePath) {
    if (!existsSync(customExePath)) {
      throw new Error(`The configured browser.exePath does not exist: ${customExePath}`);
    }
    exePath = customExePath;
    await appendDebugLog("embiody_browser", "using custom exe path", { exePath });
  } else if (process.platform !== "win32") {
    // The browser is Windows only: downloading its installer here would be wasted.
    setInstallStatus({ phase: "unsupported" });
    throw new Error("BrowserDo needs Windows 10 or 11");
  } else {
    exePath = (await getInstalledExePath()) ?? (await installEmbiody());
  }
  // There is a browser now, whether just installed, installed by hand after a failed try, or configured.
  setInstallStatus({ phase: "idle" });
  return exePath;
}

// After a failed install, a browser installed by hand ends the failure.
onInstallRecheck(async () => {
  if (await getInstalledExePath().catch(() => null)) setInstallStatus({ phase: "idle" });
});

/**
 * What the MCP server does at startup: install Embiody if it is missing, and return the port of
 * a browser already running, or null. It does not start one: the first tool that needs the
 * browser does (ensureEmbiodyBrowser through the CDP client), so a client that only connects or
 * checks the server does not open the person's browser.
 */
export async function prepareEmbiodyBrowser(): Promise<number | null> {
  await ensureEmbiodyInstalled();
  const port = readExistingPort();
  return port && (await isPortAlive(port)) ? port : null;
}

let ensuring: Promise<number> | null = null;

/**
 * Make sure the Embiody browser is installed and running under EMBIODY_USER_DATA_DIR, and
 * return its CDP port. Reuses a running one; downloads and silently installs when absent;
 * starts the exe when installed but not running. Concurrent callers share one attempt, so
 * nothing launches twice.
 */
export function ensureEmbiodyBrowser(): Promise<number> {
  ensuring ??= startEmbiodyBrowser().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function startEmbiodyBrowser(): Promise<number> {
  await resetUserDataDir();
  const exePath = await ensureEmbiodyInstalled();

  const existingPort = readExistingPort();
  if (existingPort && (await isPortAlive(existingPort))) {
    await appendDebugLog("embiody_browser", "reusing a running Embiody", {
      port: existingPort,
      userDataDir: EMBIODY_USER_DATA_DIR,
      version: await readBrowserVersion(existingPort),
    });
    return existingPort;
  }

  await appendDebugLog("embiody_browser", "launching Embiody exe", {
    exePath,
    userDataDir: EMBIODY_USER_DATA_DIR,
  });
  launchExe(exePath);
  const port = await waitForPort(30_000);
  await appendDebugLog("embiody_browser", "Embiody ready", {
    port,
    exePath,
    version: await readBrowserVersion(port),
  });
  return port;
}

/**
 * Read the browser's self-reported version string from /json/version, of the form
 * "Chrome/141.0.7390.123 Embiody/0.8.0.20". Used only for logs and error messages — "which
 * build am I actually connected to" must always be answerable.
 */
export async function readBrowserVersion(port: number): Promise<string> {
  try {
    const resp = await fetch(`http://${CDP_DEFAULT_HOST}:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!resp.ok) return `unknown (HTTP ${resp.status})`;
    return String(((await resp.json()) as { Browser?: string }).Browser ?? "unknown");
  } catch {
    return "unknown";
  }
}

/**
 * The browser build does not match the protocol this project targets.
 * It gets its own type so the entry point can print just this message: it is troubleshooting
 * guidance meant for a person, and a trail of "at ..." frames only dilutes it while telling
 * nobody anything about a configuration problem.
 */
export class ProtocolMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMismatchError";
  }
}

/**
 * Confirm before starting that the browser build can carry this protocol.
 *
 * The probe is browserGetWindowInfo: it takes no arguments, is read-only and has no side
 * effects, and it is precisely the command the September 2026 protocol revision renamed from the plural
 * browserGetWindowInfos — an older build is guaranteed to answer "wasn't found".
 * /json/protocol does not publish the Embiody domain (measured: not among its 53 domains),
 * so the command list is unavailable and one representative command has to stand in.
 *
 * What this does not do: gate on the version number. There is no published mapping from
 * version to protocol round, so gating would only trade a clear "this command is missing"
 * for a magic number somebody has to maintain.
 */
export async function assertProtocolSupported(
  cdp: CdpClient,
  port?: number,
): Promise<void> {
  try {
    await cdp.sendCommand("Embiody.browserGetWindowInfo", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/wasn't found|not found/i.test(message)) {
      // The command exists and this one call failed (a connection blip, say). Not a version
      // problem, so let the normal error path handle it.
      throw error;
    }
    const version = port ? await readBrowserVersion(port) : "unknown";
    throw new ProtocolMismatchError(
      [
        "This browser build is older than the protocol this project targets",
        "(the September 2026 revision of embiody_protocol.pdl).",
        `Current browser: ${version}`,
        "Embiody.browserGetWindowInfo is missing. That command was renamed from",
        "browserGetWindowInfos in that revision, and the same batch added or renamed browserNewWindow /",
        "browserNewTab / browserGoBack / browserGoForward / browserReload / browserStopLoading /",
        "browserSetAudioMuted / browserClosePopupBubble / browserStartHumanControl /",
        "browserStopHumanControl. An older build has none of them.",
        "",
        "Two ways out:",
        "  1. Install a newer release; or",
        "  2. Point browser.exePath in browserdo.config.yaml at your own build, for example",
        "     browser:",
        "       exePath: C:/path/to/embiody.exe",
        `     (a custom exe automatically uses its own profile: ${EMBIODY_USER_DATA_DIR})`,
      ].join("\n"),
    );
  }
}

/**
 * Once CDP is connected, pick a working target (windowId/tabId) via
 * Embiody.browserGetWindowInfo.
 *
 * Selection order (not simply windows[0].tabs[0], which may be the tab a person is using):
 *   1. a tab that is already an agent tab (isAgentTab) — safest to resume or reuse
 *   2. a blank page (about:blank / newtab) — the one the exe opens, nobody is using it
 *   3. otherwise fall back to the first tab of the first window, and write that concession
 *      into the debug log
 */
export async function discoverWorkingTarget(
  cdp: CdpClient,
): Promise<{
  windowId: string;
  tabId: string;
  url: string;
  /** The layout fetched while picking the target. Callers reuse it as this round's layout, saving a query. */
  layout: WindowInfo[];
}> {
  const windows = await browserGetWindowInfo(cdp);
  const candidates = windows.flatMap((win) =>
    win.tabs
      .filter((tab) => win.windowId && tab.tabId)
      .map((tab) => ({ win, tab })),
  );

  if (candidates.length === 0) {
    throw new Error(
      `browserGetWindowInfo returned no usable window or tab: ${JSON.stringify(windows).slice(0, 500)}`,
    );
  }

  // "Idle" means nobody is using it and it is safe to take over: blank pages and new tabs.
  // Note this is a different question from "can it be captured" — a new tab can be
  // (see snapshotBlockedReason).
  const isIdle = (url: string): boolean => {
    const u = (url ?? "").trim().toLowerCase();
    return (
      u === "" ||
      u === "about:blank" ||
      u.startsWith("chrome://newtab") ||
      u.startsWith("chrome://new-tab-page")
    );
  };

  const picked =
    candidates.find(({ tab }) => tab.isAgentTab) ??
    candidates.find(({ tab }) => isIdle(tab.url)) ??
    candidates[0];

  const reason = picked.tab.isAgentTab
    ? "already an agent tab (isAgentTab)"
    : isIdle(picked.tab.url)
      ? "an idle page (blank or new tab)"
      : "no agent tab and no blank tab; fell back to the first tab, which a person may be using";

  await appendDebugLog("embiody_browser", "working window discovered", {
    windowId: picked.win.windowId,
    tabId: picked.tab.tabId,
    url: picked.tab.url,
    windowState: picked.win.windowState,
    reason,
  });
  return {
    windowId: picked.win.windowId,
    tabId: picked.tab.tabId,
    url: picked.tab.url,
    layout: windows,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // A failed delete does not affect the main flow.
  }
}
