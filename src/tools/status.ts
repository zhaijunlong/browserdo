import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CdpClient } from "../cdp-client.js";
import { installProgress, recheckFailedInstall } from "../install_status.js";

export function registerStatusTool(server: McpServer, cdp: CdpClient): void {
  server.tool(
    "browser_status",
    "Say whether the browser is ready, without doing anything in it. On first use BrowserDo " +
      "downloads and installs the Embiody browser, which takes a few minutes; until then every " +
      "other tool replies with the progress instead of acting, and this one reports it.",
    {},
    async () => {
      await recheckFailedInstall();
      const text =
        installProgress() ??
        cdp.versionProblem ??
        (cdp.isConnected
          ? "The Embiody browser is ready."
          : "The Embiody browser is installed but not connected yet; the next tool that needs " +
            "it starts it, or says why it cannot.");
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
