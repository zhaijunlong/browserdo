/**
 * The oldest Embiody this BrowserDo works with. Raise it when BrowserDo starts relying on a
 * browser change, and add a row to docs/browser-versions.md.
 */
export const MIN_EMBIODY_VERSION = "0.9.0.3";

/** Where the browser checks for an update and offers to install it. */
export const BROWSER_UPDATE_URL = "chrome://settings/help";

/** The Embiody version in /json/version's Browser field ("Chrome/156.0.8078.12 Embiody/0.9.0.4"). */
export function parseEmbiodyVersion(browser: string | undefined): string | undefined {
  return /\bEmbiody\/(\d+(?:\.\d+)*)/.exec(browser ?? "")?.[1];
}

/** Numeric comparison, part by part; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Thrown for every command while the browser is too old or its version unreadable. */
export class BrowserVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserVersionError";
  }
}

export type VersionVerdict =
  | { ok: true }
  | { ok: false; tooOld: boolean; message: string };

export function checkEmbiodyVersion(browser: string | undefined): VersionVerdict {
  const version = parseEmbiodyVersion(browser);
  if (!version) {
    return {
      ok: false,
      tooOld: false,
      message:
        `Could not read the Embiody version from this browser (it reports "${browser ?? "nothing"}"). ` +
        `BrowserDo needs Embiody ${MIN_EMBIODY_VERSION} or newer.`,
    };
  }
  if (compareVersions(version, MIN_EMBIODY_VERSION) >= 0) return { ok: true };
  return {
    ok: false,
    tooOld: true,
    message:
      `This Embiody is ${version}; BrowserDo needs ${MIN_EMBIODY_VERSION} or newer. ` +
      `Update it from the browser's update page (${BROWSER_UPDATE_URL}), then restart the ` +
      `browser and then the BrowserDo MCP server.`,
  };
}
