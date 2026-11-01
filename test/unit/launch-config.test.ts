import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLaunchArgs } from "../../src/embiody-browser.js";
import { EMBIODY_USER_DATA_DIR } from "../../src/config.js";

/**
 * The launch command line and how the profile directory is derived.
 *
 * Both fail in ways that are hard to see:
 * - Hitting one of Chrome's kBadFlags shows the "unsupported command-line flag" bar, and that
 *   bar pushes the whole viewport down — from then on a snapshot's bbox no longer lines up with
 *   click coordinates, which looks like the coordinates being computed wrongly.
 * - A custom exePath sharing the installed build's profile makes ensureEmbiodyBrowser reuse the
 *   installed build's DevToolsActivePort, so the custom build never starts and every behaviour
 *   seen while debugging is the old one's.
 */

describe("the launch command line", () => {
  const args = buildLaunchArgs();

  it("holds no flag that would show the \"unsupported command-line flag\" bar", () => {
    // Taken from kBadFlags in chrome/browser/ui/startup/bad_flags_prompt.cc, listing only the
    // ones we might plausibly want to add that really are on that list.
    const badFlags = [
      "--disable-blink-features",
      "--enable-blink-features",
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--single-process",
      "--ignore-certificate-errors",
      "--host-resolver-rules",
      "--host-rules",
      "--use-fake-ui-for-media-stream",
      "--disable-best-effort-tasks",
      "--enable-gpu-benchmarking",
      "--unsafely-treat-insecure-origin-as-secure",
    ];
    const offenders = args.filter((a) =>
      badFlags.some((bad) => a === bad || a.startsWith(`${bad}=`)),
    );
    assert.deepEqual(
      offenders,
      [],
      `these flags show the bar and push the viewport down: ${offenders.join(" ")}`,
    );
  });

  it("has all the core parameters", () => {
    assert.ok(args.includes(`--user-data-dir=${EMBIODY_USER_DATA_DIR}`));
    assert.ok(args.includes("--remote-debugging-port=0"));
    assert.ok(args.includes("--start-maximized"));
    assert.equal(args.at(-1), "about:blank", "the start page must be the very last argument");
  });

  it("EMBIODY_EXTRA_FLAGS appends rather than replaces", () => {
    const before = buildLaunchArgs();
    process.env.EMBIODY_EXTRA_FLAGS = "--no-sandbox --disable-gpu";
    try {
      const after = buildLaunchArgs();
      assert.ok(after.includes("--no-sandbox"));
      assert.ok(after.includes("--disable-gpu"));
      assert.ok(
        after.includes("--no-first-run"),
        "the default flags must not be pushed out by extraFlags",
      );
      assert.equal(after.length, before.length + 2);
    } finally {
      delete process.env.EMBIODY_EXTRA_FLAGS;
    }
  });

  it("EMBIODY_LAUNCH_FLAGS replaces the default flags wholesale (for bisecting a problem flag)", () => {
    process.env.EMBIODY_LAUNCH_FLAGS = "--only-this";
    try {
      const args2 = buildLaunchArgs();
      assert.ok(args2.includes("--only-this"));
      assert.ok(!args2.includes("--no-first-run"), "in override mode none of the default flags apply");
      assert.ok(
        args2.includes("--remote-debugging-port=0"),
        "the core parameters are unaffected by the override",
      );
    } finally {
      delete process.env.EMBIODY_LAUNCH_FLAGS;
    }
  });

  it("a blank EMBIODY_LAUNCH_FLAGS keeps the default flags", () => {
    process.env.EMBIODY_LAUNCH_FLAGS = "   ";
    try {
      assert.deepEqual(buildLaunchArgs(), args);
    } finally {
      delete process.env.EMBIODY_LAUNCH_FLAGS;
    }
  });

  it("with both variables: the override, then the extras, then the core arguments", () => {
    process.env.EMBIODY_LAUNCH_FLAGS = " --a\t--b ";
    process.env.EMBIODY_EXTRA_FLAGS = "--c";
    try {
      const got = buildLaunchArgs();
      assert.deepEqual(got.slice(0, 3), ["--a", "--b", "--c"]);
      assert.equal(got.at(-1), "about:blank");
    } finally {
      delete process.env.EMBIODY_LAUNCH_FLAGS;
      delete process.env.EMBIODY_EXTRA_FLAGS;
    }
  });
});

describe("deriving the profile directory", () => {
  // config.ts fixes EMBIODY_USER_DATA_DIR when the module loads, so the derivation has to be checked by reloading the module.
  async function userDataDirWith(
    env: Record<string, string | undefined>,
  ): Promise<string> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      // A cache-buster query string forces the module's top-level constants to be evaluated again.
      const mod = await import(`../../src/config.js?dir=${Math.random()}`);
      return (mod as { EMBIODY_USER_DATA_DIR: string }).EMBIODY_USER_DATA_DIR;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("shares the person's own Embiody folder when there is no custom exe", async () => {
    const dir = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: undefined,
    });
    assert.match(dir, /Embiody[\\/]Embiody[\\/]User Data$/);
  });

  it("derives its own profile for a custom exe, never sharing the installed build's", async () => {
    const installed = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: undefined,
    });
    const dev = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/embiody/out/Release/embiody.exe",
    });
    assert.notEqual(
      dev,
      installed,
      "a shared profile would make ensureEmbiodyBrowser reuse the installed build's port",
    );
    assert.match(dev, /AgentUser-dev-[0-9a-f]{8}$/);
  });

  it("the same exe path derives the same profile (reuse has to be stable)", async () => {
    const a = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Release/embiody.exe",
    });
    const b = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Release/embiody.exe",
    });
    assert.equal(a, b);
  });

  it("different builds derive different profiles (Debug and Release do not contaminate each other)", async () => {
    const rel = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Release/embiody.exe",
    });
    const dbg = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Debug/embiody.exe",
    });
    assert.notEqual(rel, dbg);
  });

  // Windows paths are case-insensitive: one exe spelled two ways is one build.
  it("the same exe in another letter case derives the same profile", async () => {
    const a = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Release/embiody.exe",
    });
    const b = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: undefined,
      EMBIODY_EXE_PATH: "c:/PATH/TO/X/OUT/release/Embiody.exe",
    });
    assert.equal(a, b);
  });

  it("an explicitly configured browser.userDataDir wins over everything", async () => {
    const dir = await userDataDirWith({
      EMBIODY_USER_DATA_DIR: "C:/path/to/my/own/profile",
      EMBIODY_EXE_PATH: "C:/path/to/x/out/Release/embiody.exe",
    });
    assert.equal(dir, "C:/path/to/my/own/profile");
  });
});
