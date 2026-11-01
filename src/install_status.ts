import { EMBIODY_GITHUB_DOWNLOAD_BASE, EMBIODY_INSTALLER_NAME } from "./config.js";

/** How far an install BrowserDo started has got; idle when nothing is being installed. */
export type InstallStatus =
  | { phase: "idle" }
  | { phase: "downloading"; source: "GitHub" | "cnb"; received: number; total: number | null; startedAt: number }
  | { phase: "installing" }
  | { phase: "failed"; error: string };

let status: InstallStatus = { phase: "idle" };
let retry: () => void = () => {};

export function setInstallStatus(next: InstallStatus): void {
  status = next;
}

/** How to start the install again; embiody-browser sets it, tests stub it. */
export function onInstallRetry(fn: () => void): void {
  retry = fn;
}

const MB = 1024 * 1024;

/**
 * The install's state in a sentence, or null when nothing is being installed. A failed install
 * is started again first, so each call while it stays failed retries once.
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
    case "failed":
      retry();
      return (
        `Installing the Embiody browser failed: ${status.error}. The download has started again. ` +
        `To install it by hand: ${EMBIODY_GITHUB_DOWNLOAD_BASE}/${EMBIODY_INSTALLER_NAME}`
      );
  }
}
