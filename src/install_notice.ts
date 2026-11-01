import { appendDebugLog } from "./logger.js";

export const INSTALL_NOTICE =
  "Embiody was installed. By using it you agree to the Embiody EULA (https://embiody.com/eula). " +
  "Privacy policy: https://embiody.com/privacy.";

let pending = false;

/** After BrowserDo installs Embiody: tell the log and stderr now, and the next tool reply. */
export function noteInstalled(): void {
  pending = true;
  console.error(INSTALL_NOTICE);
  void appendDebugLog("embiody_browser", INSTALL_NOTICE);
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };

/** Put the notice first in this reply if one is waiting; only the first reply after an install gets it. */
export function withInstallNotice<T extends ToolResult>(result: T): T {
  if (!pending) return result;
  pending = false;
  return { ...result, content: [{ type: "text", text: INSTALL_NOTICE }, ...(result.content ?? [])] };
}
