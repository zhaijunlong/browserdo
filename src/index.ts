#!/usr/bin/env node

// Only the config loader, browser_version and tool_set are imported statically (none reads env at import).
// Everything else uses dynamic import so it loads after loadRuntimeConfigFile() has put the
// config file's values into process.env.
import { createInterface } from "node:readline/promises";
import { loadRuntimeConfigFile } from "./runtime_config.js";
import { BrowserVersionError } from "./browser_version.js";
import { parseToolSet, type ToolSet } from "./tool_set.js";

type Transport = "sse" | "stdio";

function now(): string {
  return new Date().toLocaleTimeString("en-GB"); // HH:MM:SS
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

/**
 * Step debugging: stop BEFORE each batch of actions runs and wait for a key.
 *
 * Why here: the runtime is a generator and the "Running ..." event is yielded before the
 * actions execute. If the consumer does not call next(), the generator simply waits — the
 * page is still exactly as the model saw it and the plan has already been printed, which is
 * the moment to open DevTools and see why it picked that emsn. This lives entirely on the
 * consumer side; the runtime needs no changes.
 */
class Stepper {
  private continueAll = false;

  constructor(
    private readonly enabled: boolean,
    private readonly fromRound: number,
  ) {}

  async pause(round: number): Promise<void> {
    if (!this.enabled || this.continueAll || round < this.fromRound) return;
    if (!process.stdin.isTTY) {
      // With no readable terminal (redirected or piped) we must not wait, or the task hangs.
      console.log(
        `[step] round=${round} reached a pause point, but stdin is not a terminal so no key can be read — carrying on`,
      );
      return;
    }
    console.log(
      `
[step] round=${round} paused BEFORE the actions run. The page is exactly as the ` +
        `model saw it, so you can inspect elements in DevTools.
` +
        `        Enter = run this batch and keep stepping   c = stop pausing, run to the end   q = quit now`,
    );
    const key = await this.readLine();
    if (key === "q") {
      console.log("[step] quitting on q; the browser is left as it is");
      this.close();
      process.exit(0);
    }
    if (key === "c") {
      this.continueAll = true;
      console.log("[step] no further pauses");
    }
  }

  private readLine(): Promise<string> {
    return new Promise((resolve) => {
      const onData = (chunk: Buffer | string) => {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(String(chunk).trim().toLowerCase());
      };
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
  }

  close(): void {
    if (this.enabled && process.stdin.isTTY) {
      process.stdin.pause();
    }
  }
}

/**
 * The command-line side of "ask the human": print the question, read one line back, and
 * let the task continue.
 *
 * Three inputs: a line of text is the answer; a bare Enter is an empty answer (what that
 * means is up to the runtime and the kind of pause — for a pause that needed the person to
 * act on the page it counts as "done"); q means stop, and the task finishes as paused.
 *
 * There is no flag for this: running in a terminal is interactive by definition. When
 * stdin is not a terminal (a pipe, CI) it returns undefined and the runtime falls back to
 * "carry the question out and finish" rather than waiting for an Enter that never comes.
 *
 * Uses readline rather than listening to data itself: an answer is a whole sentence and may
 * arrive in several chunks, and a multi-byte UTF-8 character split across a chunk boundary
 * comes out as mojibake.
 */
function makeCliAskHuman(): ((question: string) => Promise<string | undefined>) | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question: string): Promise<string | undefined> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\n[your answer needed] ${question}\n        Enter = empty reply    q = stop the task\n> `,
      );
      const text = answer.trim();
      return text.toLowerCase() === "q" ? undefined : text;
    } finally {
      rl.close();
    }
  };
}

function parseArgs(): {
  config?: string;
  cdpHost?: string;
  transport: Transport;
  runtimeTask?: string;
  maxRounds?: number;
  closeBrowserWindowWhenDone: boolean;
  totalTimeoutMs?: number;
  step: boolean;
  stepFrom: number;
  toolSet: ToolSet;
} {
  const args = process.argv.slice(2);
  let config: string | undefined;
  let cdpHost: string | undefined;
  let transport: Transport = "stdio";
  let runtimeTask: string | undefined;
  let maxRounds: number | undefined;
  let closeBrowserWindowWhenDone = false;
  let totalTimeoutMs: number | undefined;
  let step = false;
  let stepFrom = 0;
  let toolSet: ToolSet = parseToolSet(process.env.EMBIODY_TOOLS);

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config":
        config = args[++i];
        break;
      // This machine only (e.g. 127.0.0.1 vs localhost): the browser is still installed,
      // launched and its port read here, so a browser on another machine is not supported.
      case "--cdp-host":
        cdpHost = args[++i];
        break;
      // Which tool set to offer: all (default), task, or browser.
      case "--tools":
        toolSet = parseToolSet(args[++i]);
        break;
      // SSE only when asked for by name: it serves HTTP on port 3000, and a typo must not turn it on.
      case "--transport": {
        const value = args[++i];
        if (value !== "stdio" && value !== "sse") {
          console.error(`Unknown --transport ${value}: use stdio (the default) or sse`);
          process.exit(1);
        }
        transport = value;
        break;
      }
      case "--runtime-task":
        runtimeTask = args[++i];
        break;
      case "--max-rounds":
        maxRounds = parseInt(args[++i], 10);
        break;
      case "--close-browser-window-when-done":
        closeBrowserWindowWhenDone = true;
        break;
      case "--total-timeout-ms":
        totalTimeoutMs = parseInt(args[++i], 10);
        break;
      // Step debugging: pause for a key before each batch of actions.
      case "--step":
        step = true;
        break;
      // Start stepping from round N; the earlier rounds run straight through.
      case "--step-from":
        step = true;
        stepFrom = parseInt(args[++i], 10) || 0;
        break;
    }
  }

  return {
    config,
    cdpHost,
    transport,
    runtimeTask,
    maxRounds,
    closeBrowserWindowWhenDone,
    totalTimeoutMs,
    step,
    stepFrom,
    toolSet,
  };
}

async function main() {
  const {
    config,
    cdpHost,
    transport,
    runtimeTask,
    maxRounds,
    closeBrowserWindowWhenDone,
    totalTimeoutMs,
    step,
    stepFrom,
    toolSet,
  } = parseArgs();

  // 1) Load the runtime config file first (it fills process.env).
  loadRuntimeConfigFile(config);

  // 2) Only then dynamically import the modules that read those env vars.
  const { createSseApp, listenSse, SSE_HOST, startStdio } = await import("./server.js");
  const { CdpClient } = await import("./cdp-client.js");
  const { BrowserRunTaskRuntime } = await import("./runtime_browser_run_task.js");
  const {
    ensureEmbiodyBrowser,
    isEmbiodyInstalled,
    prepareEmbiodyBrowser,
    readExistingPort,
    assertProtocolSupported,
    readBrowserVersion,
    ProtocolMismatchError,
  } = await import("./embiody-browser.js");
  const { CDP_DEFAULT_HOST } = await import("./config.js");

  const host = cdpHost ?? CDP_DEFAULT_HOST;
  // Finding a restarted browser reads this machine's port file and may start the browser here,
  // so only for a browser on this machine.
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const rediscovery = local
    ? { currentPort: readExistingPort, ensureRunning: ensureEmbiodyBrowser }
    : undefined;

  // 3) Lifecycle: started now, so a first install's download begins at once. The command line
  //    needs the browser running (EMBIODY_USER_DATA_DIR) and waits for it here; the MCP server
  //    only installs it and leaves starting it to the first tool that needs it.
  const browserReady = runtimeTask ? ensureEmbiodyBrowser() : prepareEmbiodyBrowser();
  // Its failure is handled below, after an await; without this Node would count it unhandled first.
  browserReady.catch(() => {});

  if (runtimeTask) {
    const port = (await browserReady)!;
    const cdpClient = new CdpClient(host, port, rediscovery);
    const stepper = new Stepper(step, stepFrom);
    await cdpClient.connect();
    console.log(
      `[${now()}] browser: ${await readBrowserVersion(port)}  port ${port}`,
    );
    try {
      await assertProtocolSupported(cdpClient, port);
    } catch (error) {
      // A version mismatch is a configuration problem: print the guidance, not a stack trace.
      if (error instanceof ProtocolMismatchError || error instanceof BrowserVersionError) {
        console.error(red(error.message));
        process.exit(1);
      }
      throw error;
    }
    if (step) {
      console.log(
        `[${now()}] step mode on${stepFrom ? ` (from round=${stepFrom})` : ""}: pauses for a key before each batch of actions`,
      );
    }

    const runtime = new BrowserRunTaskRuntime(cdpClient, {
      task: runtimeTask,
      maxRounds,
      closeBrowserWindowWhenDone,
      totalTimeoutMs,
      askHuman: makeCliAskHuman(),
    });

    let finalPlan: { next_step_detail?: { is_paused?: boolean } } | undefined;
    for await (const event of runtime.run()) {
      const ts = now();
      // A run that finished without completing: paused for a person, or stopped. Read the
      // plan's own flag rather than matching the message text, which drifts with the wording.
      const isError =
        event.type === "complete" && event.plan?.all_task_is_complete !== true;
      const msg = `[${ts}] [round=${event.round}] [stage=${event.stage}] ${event.message}`;
      console.log(isError ? red(msg) : msg);

      // Print the actions only on the act event that comes BEFORE they run; the act-finished
      // event already carries the outcome, so printing again would duplicate. The two are told
      // apart by executionResult, which only the finished event sets — not by the message text,
      // which drifts. A round may hold several actions, printed in execution order.
      if (
        event.stage === "act" &&
        event.executionResult === undefined &&
        event.plan?.next_step_detail?.action_calls?.length
      ) {
        event.plan.next_step_detail.action_calls.forEach((c, i) => {
          console.log(
            `action_calls[${i}]: ${c.function} ${JSON.stringify(c.params)}`,
          );
        });

        // The step-debugging pause point; Stepper says why it is here.
        await stepper.pause(event.round);
      }

      if (event.stage === "decide" && event.plan) {
        console.log(JSON.stringify(event.plan, null, 2));
      }
      if (event.type === "complete") {
        finalPlan = event.plan;
      }
    }
    // We must exit explicitly when done: the CDP WebSocket — and, once a human has been
    // asked, the terminal's stdin — keeps the event loop alive, so a bare return leaves the
    // process hanging.
    stepper.close();
    process.stdin.pause();
    cdpClient.disconnect();
    // Three exit codes so a script can tell "needs a human" from "blew up":
    // 0 completed / 2 paused waiting for a person / 1 error.
    process.exit(finalPlan?.next_step_detail?.is_paused ? 2 : 0);
  }

  // The MCP server answers the host at once, not after the browser is up: a first install takes
  // minutes and the host would give up on the handshake. Until the install finishes every tool
  // replies with its progress (server.ts).
  const installing = !(await isEmbiodyInstalled());
  const cdpClient = new CdpClient(host, readExistingPort() ?? 0, rediscovery);
  browserReady.then(
    async (port) => {
      // Not running: the first tool that needs it starts it (the CDP client's rediscovery).
      if (!port) return;
      cdpClient.connectWithRetry(port);
      for (let i = 0; i < 60 && !cdpClient.isConnected; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!cdpClient.isConnected) return;
      console.error(`[${now()}] browser: ${await readBrowserVersion(port)}`);
      try {
        await assertProtocolSupported(cdpClient, port);
      } catch (e) {
        console.error(red(e instanceof Error ? e.message : String(e)));
      }
    },
    // Not fatal: the next tool that needs the browser tries again and reports why it failed.
    (e) => console.error(red(`Preparing the browser failed: ${e instanceof Error ? e.message : String(e)}`)),
  );

  if (transport === "stdio") {
    await startStdio(cdpClient, toolSet, installing);
  } else {
    const app = createSseApp(cdpClient, toolSet, installing);
    listenSse(app, 3000, () => {
      console.error(`browserdo listening on http://${SSE_HOST}:3000`);
      console.error(`SSE endpoint: http://${SSE_HOST}:3000/sse`);
      console.error(`CDP target: ${host}`);
    });
  }
}

main().catch((err) => {
  // Format defensively: a complex error object (a ZodError, say) can crash util.inspect and
  // bury the real error.
  let message: string;
  try {
    message = err instanceof Error ? err.stack ?? err.message : String(err);
  } catch {
    message = String(err);
  }
  console.error(red(`[${now()}] Fatal error: ${message}`));
  process.exit(1);
});
