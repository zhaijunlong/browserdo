import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Configurable constants and hard-coded paths, in one place. Most can be overridden by an
 * environment variable.
 */

/** Debug log file: URLs and steps, never page content or the task text. EMBIODY_DEBUG_LOG moves it for tests only. */
export const DEBUG_LOG_PATH =
  process.env.EMBIODY_DEBUG_LOG ??
  path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Embiody", "BrowserDo", "logs", "debug.log",
  );

/**
 * Save every snapshot (raw image, annotated image, annotatedContent) to SNAPSHOT_DIR. Off by
 * default: the files copy whatever was browsed, signed-in pages included, and nothing deletes them.
 */
export const SAVE_SNAPSHOTS = process.env.EMBIODY_SAVE_SNAPSHOTS === "1";

/** Where saved snapshots, and the EMBIODY_LOG_PROMPT dumps, land. */
export const SNAPSHOT_DIR =
  process.env.EMBIODY_SNAPSHOT_DIR ??
  path.join(process.cwd(), "run", "browser_data");

/**
 * Write each round's full prompt and raw reply to disk. Off by default: a prompt is over ten
 * thousand characters and one per round fills the log fast.
 *
 * It is the only way to answer "why did the model pick that emsn" — debug.log records the
 * outcome of a decision, not what the model saw. Lands in SNAPSHOT_DIR beside that round's
 * screenshots, with the round in the filename.
 */
export const LOG_PROMPT = process.env.EMBIODY_LOG_PROMPT === "1";

/** Where Windows records an installed embiody.exe (App Paths): a per-user install first, then per-machine. */
export const EMBIODY_APP_PATHS_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\embiody.exe",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\embiody.exe",
];

/**
 * The main download source: the newest GitHub release. The installer name carries no version, so
 * `latest/download/<name>` always gets the newest one; SHA256SUMS.txt beside it holds its checksum.
 */
export const EMBIODY_GITHUB_DOWNLOAD_BASE =
  "https://github.com/zhaijunlong/embiody-dist/releases/latest/download";
/**
 * The statistics channel of the installer BrowserDo downloads: NPMX for the npm package; an mcpb
 * fixes its own at build time (scripts/build-mcpb.mjs --channel, e.g. CLDD for Claude Desktop);
 * the Claude plugin sets BROWSERDO_CHANNEL in claude/plugin/.mcp.json.
 */
export const EMBIODY_CHANNEL = process.env.BROWSERDO_CHANNEL || "NPMX";
export const EMBIODY_INSTALLER_NAME = `EmbiodySetup-Offline-${EMBIODY_CHANNEL}.exe`;

/** The fallback source. Release page; the `latest=<url>` line in its Overview points at the newest installer. */
export const EMBIODY_RELEASES_PAGE_URL =
  "https://cnb.cool/selectious/embiody/release/embiody_releases/-/releases/tag/ReleaseList";

/**
 * A custom exe (browser.exePath) gets its own profile, derived from the exe path.
 *
 * It must not share the installed build's: DevToolsActivePort lives in user-data-dir and
 * ensureEmbiodyBrowser reuses any live port it finds there, so a shared profile silently
 * connects to the installed build while the custom exe never starts — and everything you then
 * debug is the old build's behaviour.
 */
function devUserDataDir(exePath: string): string {
  const tag = createHash("sha1")
    .update(path.resolve(exePath).toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return path.join(process.env.APPDATA ?? "", "embiody", `AgentUser-dev-${tag}`);
}

/**
 * By default BrowserDo shares the person's own Embiody: its Default profile, in the browser they
 * use. browser.userDataDir or a custom exe instead gives it a browser of its own on a separate
 * profile, which BrowserDo starts with its own flags.
 */
export const SHARED_PROFILE =
  !process.env.EMBIODY_USER_DATA_DIR?.trim() && !process.env.EMBIODY_EXE_PATH?.trim();

/** The UserDataDir policy, machine before user as the browser reads it (install_static/user_data_dir.cc). */
function userDataDirPolicy(): string | null {
  for (const root of ["HKLM", "HKCU"]) {
    try {
      const out = execFileSync("reg", ["query", `${root}\\SOFTWARE\\Policies\\Embiody\\Embiody`, "/v", "UserDataDir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const value = out.match(/UserDataDir\s+REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1].trim();
      if (value) return value;
    } catch {
      // Not set.
    }
  }
  return null;
}

/** Expand the policy's ${...} variables that name a per-user folder; others are left as written. */
export function expandPolicyPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const vars: Record<string, string | undefined> = {
    local_app_data: env.LOCALAPPDATA,
    roaming_app_data: env.APPDATA,
    profile: env.USERPROFILE,
    user_name: env.USERNAME,
    machine_name: env.COMPUTERNAME,
  };
  return value.replace(/\$\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/**
 * The person's own user data folder: the policy's if one is set, else the browser's default
 * (install_static/user_data_dir.cc), the same for per-user and per-machine installs.
 */
export function sharedUserDataDir(policy: string | null = userDataDirPolicy()): string {
  if (policy) return expandPolicyPath(policy);
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Embiody", "Embiody", "User Data");
}

/** Precedence: the browser.userDataDir setting > derived from exePath > the person's own. */
export const EMBIODY_USER_DATA_DIR =
  process.env.EMBIODY_USER_DATA_DIR?.trim() ||
  (SHARED_PROFILE ? sharedUserDataDir() : devUserDataDir(process.env.EMBIODY_EXE_PATH!.trim()));

/**
 * Reset the profile to a fixed starting state before every launch. Off by default.
 *
 * Pages remember the last run in the profile (cookies, localStorage), so one round's mistake
 * is inherited by the next: three consecutive runs once each started from a different date
 * left behind by the run before, which makes comparing models across them meaningless.
 *
 * This only clears; with EMBIODY_PROFILE_BASELINE it then copies a fixed snapshot back, to
 * reproduce the "with leftovers" case on purpose.
 */
export const EMBIODY_RESET_PROFILE =
  process.env.EMBIODY_RESET_PROFILE === "1" ||
  process.env.EMBIODY_RESET_PROFILE === "true";

/** Copy the starting profile from here after a reset (empty = just clear). */
export const EMBIODY_PROFILE_BASELINE =
  process.env.EMBIODY_PROFILE_BASELINE?.trim() || undefined;

/** Default CDP host; the port comes from DevToolsActivePort at runtime. */
export const CDP_DEFAULT_HOST = process.env.EMBIODY_CDP_HOST ?? "localhost";

/**
 * How long to wait for one CDP command. **Must not go below 10s**: browserInputText waits up
 * to 10 seconds for input focus on a busy renderer, and timing out first cuts off a call that
 * was going to succeed. Click and input add a hit-test round trip on top, so leave room.
 */
export const CDP_COMMAND_TIMEOUT_MS = Number(
  process.env.EMBIODY_CDP_COMMAND_TIMEOUT_MS ?? 30_000,
);

/**
 * Send the model the raw image alongside the annotated one. On by default; only "0" turns it off.
 *
 * The annotated image is not a superset of the raw one: the number labels cover the elements
 * they label (adjacent numbers overlap on dense controls and the text underneath becomes
 * unreadable), and it is not complete (one snapshot had 138 emsn in annotatedContent while the
 * main search button carried no label at all). Numbers come from annotatedContent, never the
 * image.
 *
 * The two are pixel aligned, so the model can cross-reference by coordinate. Cost: images are
 * 8% of the prompt, so one more adds about 8% of input. Turning it off saves no capture: the
 * annotated image still takes the screenshot.
 */
export const SNAPSHOT_RETURN_IMAGE =
  (process.env.EMBIODY_SNAPSHOT_RETURN_IMAGE ?? "1") !== "0";

/**
 * Whole-command deadline for one snapshot; the kernel default is 7000.
 *
 * The kernel splits it: everything except a 2-second capture reserve goes to waiting for load,
 * so the default is "wait 5s, capture 2s". Below 2000 is raised to 2000; 0 means "capture this
 * instant".
 *
 * **Unlike browserNavigate's timeoutMs**, reaching this deadline may still return a usable
 * snapshot, with a message saying loading had not finished; only getting nothing is an error.
 */
export const SNAPSHOT_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.EMBIODY_SNAPSHOT_TIMEOUT_MS ?? 7000),
);

/**
 * How many rounds in a row the same "next step" may appear. The count also requires the page
 * to be byte-for-byte unchanged; see BrowserRuntimeMemory.targetRepeatIfAdopted.
 *
 * This is the runtime's backstop, not advice to the model. The prompt already asks it to change
 * approach after three rounds without progress, but weaker models measurably do not: one spun
 * on the same leaf for 6 rounds, changing emsn and claiming completion each time, with the page
 * never changing.
 *
 * The test is `repeat <= MAX`, so the runtime only acts on round 4 — the model still gets one
 * round to handle it itself.
 */
export const MAX_SAME_TARGET_ROUNDS = Math.max(
  2,
  Number(process.env.EMBIODY_MAX_SAME_TARGET_ROUNDS ?? 3),
);

/**
 * How many actions may run in one round.
 *
 * Every action in a batch bets on the same snapshot, and the later the action, the likelier
 * that snapshot no longer holds. The cap on screenshots (20) can be generous because extra
 * captures only cost tokens; an extra action is another bet on possibly stale knowledge.
 *
 * 5 is too tight: an ordinary form batch (origin, destination, dates, search) sits right at
 * that cap. A batch runs in order and stops at the
 * first error, so extra actions are never run blindly.
 */
export const MAX_ACTIONS_PER_ROUND = Math.max(
  1,
  Number(process.env.EMBIODY_MAX_ACTIONS_PER_ROUND ?? 10),
);

/**
 * Wait before retrying a failed snapshot. Configurable rather than hard-coded so tests can run
 * fast — a hard-coded wait once made a clamp test really sleep 10 seconds. Only a
 * non-deterministic failure reaches here.
 */
export const SNAPSHOT_RETRY_DELAY_MS = Number(
  process.env.EMBIODY_SNAPSHOT_RETRY_DELAY_MS ?? 2000,
);

/**
 * Wait after an action for the page to settle. Navigation gets longer.
 *
 * Most of this is duplicated work — the browserTakeSnapshot that follows waits for load by
 * itself (5 seconds by default) — **but it cannot go to 0**: a snapshot waits for the load
 * event, and a JS re-render triggered by a click has no load event. That is the one case this
 * covers.
 *
 * **1000 is too tight.** Capturing one second after a channel switch gave a snapshot
 * with the target fields not yet rendered; the model settled for a neighbouring number and
 * typed into the wrong element. The arithmetic: 1.5 extra seconds against a round of roughly 19
 * is 8%, while waiting too little once cost about 130 seconds.
 */
export const POST_ACTION_WAIT_MS = Number(
  process.env.EMBIODY_POST_ACTION_WAIT_MS ?? 2500,
);
export const POST_NAVIGATE_WAIT_MS = Number(
  process.env.EMBIODY_POST_NAVIGATE_WAIT_MS ?? 6000,
);

/**
 * Pause between rounds. **0 by default**: a model call of a dozen seconds follows immediately,
 * and settling is already handled above. The field stays so a site that needs deliberate
 * slowing down (rate limiting) has somewhere to configure it.
 */
export const ROUND_INTERVAL_MS = Number(
  process.env.EMBIODY_ROUND_INTERVAL_MS ?? 0,
);
