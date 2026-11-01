import WebSocket from "ws";
import { BROWSER_UPDATE_URL, BrowserVersionError, checkEmbiodyVersion, type VersionVerdict } from "./browser_version.js";
import { CDP_COMMAND_TIMEOUT_MS } from "./config.js";

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CdpEventHandler = (method: string, params: any) => void;

/** How to find the browser again after it restarts: it comes back on a new port. */
export interface Rediscovery {
  /** The port a running browser is on, or null. Must not start one: the background retries use it. */
  currentPort: () => number | null;
  /**
   * Start the browser if needed and return its port. Only a command that finds no connection
   * calls this; retrying in the background would reopen a window the person just closed.
   */
  ensureRunning: () => Promise<number>;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private commandId = 0;
  private pending = new Map<number, PendingCommand>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private eventHandler: CdpEventHandler | null = null;
  private recovering: Promise<string | null> | null = null;
  /** Whether the connected browser is new enough; checked on every connection. */
  private version: VersionVerdict | null = null;
  private updatePageOpened = false;

  constructor(
    private host: string,
    private port: number,
    private rediscovery?: Rediscovery,
  ) {}

  async connect(): Promise<void> {
    const { url, browser } = await this.discoverBrowserEndpoint();
    this.version = checkEmbiodyVersion(browser);
    this.updatePageOpened = false;
    await this.connectWebSocket(url);
  }

  /** Keep trying to connect in the background; port is where the browser was just started. */
  connectWithRetry(port?: number): void {
    if (port) this.port = port;
    if (this.isConnected || this.recovering) return;
    const now = this.rediscovery?.currentPort();
    if (now) this.port = now;
    this.connect()
      .then(() => {
        console.error(`CDP connected to ${this.host}:${this.port}`);
      })
      .catch(() => {
        console.error(`CDP not available at ${this.host}:${this.port}, retrying in 3s...`);
        this.reconnectTimer = setTimeout(() => {
          this.connectWithRetry();
        }, 3_000);
      });
  }

  get isConnected(): boolean {
    return this.connected && this.ws !== null;
  }

  /** Why the connected browser cannot be used (too old, version unreadable), or null. */
  get versionProblem(): string | null {
    return this.version && !this.version.ok ? this.version.message : null;
  }

  onEvent(handler: CdpEventHandler): void {
    this.eventHandler = handler;
  }

  /** Send one CDP command. timeoutMs overrides the global timeout for a command known to wait long. */
  async sendCommand(
    method: string,
    params?: object,
    timeoutMs?: number,
  ): Promise<any> {
    let why: string | null = null;
    if (!this.isConnected && this.rediscovery) why = await this.recover();
    if (!this.connected || !this.ws) {
      throw new Error(why ? `CDP not connected: ${why}` : "CDP not connected");
    }
    if (this.version && !this.version.ok) {
      // A browser too old also gets its update page opened, once per connection.
      if (this.version.tooOld && !this.updatePageOpened) {
        this.updatePageOpened = true;
        await this.send("Target.createTarget", { url: BROWSER_UPDATE_URL }).catch(() => {});
      }
      throw new BrowserVersionError(this.version.message);
    }
    return this.send(method, params, timeoutMs);
  }

  private send(method: string, params?: object, timeoutMs?: number): Promise<any> {
    const id = ++this.commandId;
    const message = JSON.stringify({ id, method, params: params ?? {} });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs ?? CDP_COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(message);
    });
  }

  /** Start the browser if need be and connect; resolves to why it failed, or null. Concurrent callers share one attempt. */
  private recover(): Promise<string | null> {
    this.recovering ??= (async () => {
      try {
        this.clearReconnectTimer();
        this.port = await this.rediscovery!.ensureRunning();
        await this.connect();
        console.error(`CDP reconnected to ${this.host}:${this.port}`);
        return null;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        console.error(`CDP recovery failed: ${why}`);
        return why;
      } finally {
        this.recovering = null;
      }
    })();
    return this.recovering;
  }

  disconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.rejectAllPending("CDP disconnected");
    this.connected = false;
  }

  /**
   * The browser's endpoint, not a page's: a page's socket closes with the page. Embiody.* is
   * served on every session type (chrome_devtools_session.cc).
   */
  private async discoverBrowserEndpoint(): Promise<{ url: string; browser?: string }> {
    // Bounded: a port that accepts but never answers would otherwise hang every command waiting
    // on this recovery.
    const response = await fetch(`http://${this.host}:${this.port}/json/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    const info: { webSocketDebuggerUrl?: string; Browser?: string } = await response.json();
    if (!info.webSocketDebuggerUrl) {
      throw new Error(`No browser endpoint at http://${this.host}:${this.port}/json/version`);
    }
    return { url: info.webSocketDebuggerUrl, browser: info.Browser };
  }

  private connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      ws.on("open", () => {
        // Two attempts can race (a background retry and a command's recovery); keep the first.
        if (this.isConnected) {
          ws.removeAllListeners();
          ws.close();
          resolve();
          return;
        }
        this.ws = ws;
        this.connected = true;
        console.error(`CDP connected to ${url}`);
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on("close", () => {
        if (ws !== this.ws) return;
        this.ws = null;
        this.connected = false;
        this.rejectAllPending("CDP connection closed");
        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        if (ws === this.ws) this.connected = false;
        reject(err);
      });
    });
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);

        if (msg.error) {
          // "Invalid parameters" says which one, and why, only in data.
          const data = typeof msg.error.data === "string" && msg.error.data ? `: ${msg.error.data}` : "";
          pending.reject(new Error(`${msg.error.message || "CDP error"}${data}`));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method && this.eventHandler) {
        this.eventHandler(msg.method, msg.params ?? {});
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    console.error("CDP disconnected, reconnecting in 3s...");
    this.reconnectTimer = setTimeout(() => {
      this.connectWithRetry();
    }, 3_000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
