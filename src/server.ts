import type { Server } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CdpClient } from "./cdp-client.js";
import { withInstallNotice } from "./install_notice.js";
import { installProgress } from "./install_status.js";
import { registerAllTools, type ToolSet } from "./tools/index.js";
import { instructionsFor } from "./server_instructions.js";

/** Tools that work without the browser, so they still run while it is being installed. */
const NO_BROWSER_NEEDED = new Set(["browser_status", "browser_stop_task"]);

export function createMcpServer(
  cdpClient: CdpClient,
  toolSet: ToolSet = "all",
  installing = false,
): McpServer {
  const mcpServer = new McpServer({
    name: "browserdo",
    version: "0.9.0",
  }, {
    instructions: instructionsFor(toolSet, installing),
    capabilities: {
      logging: {},
      tasks: {
        requests: {
          tools: {
            call: {},
          },
        },
      },
    },
    taskStore: new InMemoryTaskStore(),
    taskMessageQueue: new InMemoryTaskMessageQueue(),
  });

  // Every tool call passes through here: until the browser is installed a tool replies with the
  // progress at once instead of acting, and the first reply after an install carries the notice.
  // browser_run_task is registered as a task, not here; its run waits for the install instead.
  const register = mcpServer.tool.bind(mcpServer) as (...a: unknown[]) => unknown;
  mcpServer.tool = ((...a: unknown[]) => {
    const name = a[0] as string;
    const handler = a[a.length - 1] as (...args: unknown[]) => Promise<CallToolResult>;
    a[a.length - 1] = async (...args: unknown[]) => {
      const progress = NO_BROWSER_NEEDED.has(name) ? null : installProgress();
      if (progress) {
        return {
          content: [{ type: "text", text: `${progress} Nothing was done; call again once it is ready (browser_status checks without doing anything).` }],
          isError: true,
        };
      }
      return withInstallNotice(await handler(...args));
    };
    return register(...a);
  }) as typeof mcpServer.tool;

  registerAllTools(mcpServer, cdpClient, toolSet);

  // Embiody.authRequired is not forwarded: the pdl says the browser never sends it, and
  // provideAuthResponse refuses. A person is brought in through browserStartHumanControl.

  return mcpServer;
}

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** A page served from this machine, on any port. A request with no Origin is not from a web page and is not checked here. */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_HOSTNAMES.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function createSseApp(cdpClient: CdpClient, toolSet: ToolSet = "all", installing = false) {
  const app = express();

  // DNS rebinding protection, which the MCP spec requires of HTTP transports: under a rebound
  // name the Host is the attacker's domain, and a web page's request carries its own Origin.
  app.use(localhostHostValidation());
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!isLocalOrigin(origin)) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `Origin not allowed: ${origin}` },
          id: null,
        });
        return;
      }
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  const mcpServer = createMcpServer(cdpClient, toolSet, installing);
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(400).send("No transport found for sessionId");
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  return app;
}

/** Loopback only: the SSE endpoint has no authentication and drives a browser with the user's sign-ins. */
export const SSE_HOST = "127.0.0.1";

export function listenSse(
  app: express.Express,
  port: number,
  onListening?: () => void,
): Server {
  return app.listen(port, SSE_HOST, onListening);
}

export async function startStdio(
  cdpClient: CdpClient,
  toolSet: ToolSet = "all",
  installing = false,
): Promise<void> {
  const mcpServer = createMcpServer(cdpClient, toolSet, installing);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("browserdo stdio transport ready");
}
