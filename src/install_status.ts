import { EMBIODY_GITHUB_DOWNLOAD_BASE, EMBIODY_INSTALLER_NAME } from "./config.js";

/** How far an install BrowserDo started has got; idle when nothing is being installed. */
export type InstallStatus =
  | { phase: "idle" }
  | { phase: "downloading"; source: "GitHub" | "cnb"; received: number; total: number | null; startedAt: number }
  | { phase: "installing" }
  | { phase: "elsewhere" }
  | { phase: "unsupported" }
  | { phase: "failed"; error: string };

let status: InstallStatus = { phase: "idle" };
let recheck: () => Promise<void> = async () => {};

export function setInstallStatus(next: InstallStatus): void {
  status = next;
}

export function getInstallStatus(): InstallStatus {
  return status;
}

/** False on a system the browser does not run on: no tool will ever work there. */
export function canInstall(): boolean {
  return status.phase !== "unsupported";
}

/** How to look again for an installed browser after a failure; embiody-browser sets it, tests stub it. */
export function onInstallRecheck(fn: () => Promise<void>): void {
  recheck = fn;
}

/**
 * After a failed install, look for a browser installed by hand before answering, so the call
 * made right after installing it can already use it. Nothing is downloaded again.
 */
export async function recheckFailedInstall(): Promise<void> {
  if (status.phase === "failed") await recheck();
}

const MB = 1024 * 1024;

/**
 * The install's state in a sentence, or null when nothing is being installed. A failed install is
 * not retried: downloading again on every call would repeat the same failure (see
 * recheckFailedInstall).
 */
export function installProgress(now = Date.now()): string | null {
  switch (status.phase) {
    case "idle":
      return null;
    case "downloading": {
      const { source, received, total, startedAt } = status;
      const got = Math.round(received / MB);
      let detail = total ? `${got} of ${Math.round(total / MB)} MB` : `${got} MB so far`;
      const elapsed = (now - startedAt) / 1000;
      if (total && received > 0 && elapsed >= 1) {
        const left = ((total - received) / received) * elapsed;
        detail += left < 60 ? ", under a minute left" : `, about ${Math.ceil(left / 60)} min left`;
      }
      return `The Embiody browser is being downloaded from ${source} (${detail}); it is installed right after.`;
    }
    case "installing":
      return "The Embiody browser is downloaded and being installed; this usually takes a minute or two.";
    case "elsewhere":
      return "Another BrowserDo on this computer is downloading and installing the Embiody browser; this takes a few minutes.";
    case "unsupported":
      return `BrowserDo needs Windows 10 or 11, and this computer runs ${process.platform}; no browser tool can work here.`;
    case "failed":
      return (
        `Installing the Embiody browser failed: ${status.error}. It is tried again the next time your ` +
        `client starts BrowserDo. To install it by hand: ${EMBIODY_GITHUB_DOWNLOAD_BASE}/${EMBIODY_INSTALLER_NAME}`
      );
  }
}
