import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CdpClient } from "../cdp-client.js";
import {
  registerRuntimeBrowserRunTaskTool,
  registerBrowserStopTaskTool,
} from "../runtime_browser_run_task.js";
import { registerStatusTool } from "./status.js";
import { registerThinBrowserTools } from "./thin.js";
import type { ToolSet } from "../tool_set.js";

export { parseToolSet, type ToolSet } from "../tool_set.js";

export function registerAllTools(
  server: McpServer,
  cdpClient: CdpClient,
  toolSet: ToolSet = "all",
): void {
  registerStatusTool(server, cdpClient);
  if (toolSet === "all" || toolSet === "task") {
    registerRuntimeBrowserRunTaskTool(server, cdpClient);
    registerBrowserStopTaskTool(server);
  }
  if (toolSet === "all" || toolSet === "browser") {
    registerThinBrowserTools(server, cdpClient);
  }
}
