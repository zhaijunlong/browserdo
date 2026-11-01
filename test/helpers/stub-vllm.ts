import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake VLLM service that emits preset plans in order.
 * The runtime's vllm client accepts "the reply body is the plan object itself" (the
 * pass-through branch of extractPlanPayload), so there is no need to wrap them in an OpenAI
 * choices envelope here.
 */
export class StubVllm {
  private server?: http.Server;
  private queue: unknown[] = [];
  readonly requests: unknown[] = [];
  /** Once the queue is empty, repeat the last plan — so a test does not 500 merely because it ran one more round. */
  private last: unknown;

  constructor(plans: unknown[] = []) {
    this.queue = [...plans];
    this.last = plans.at(-1);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          this.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          this.requests.push(null);
        }
        const plan = this.queue.shift() ?? this.last;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(plan ?? {}));
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1/chat/completions`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /** The user prompt text the model saw on the last request, for asserting that tab state was fed in. */
  lastUserPrompt(): string {
    const body = this.requests.at(-1) as
      | { messages?: Array<{ role?: string; content?: unknown }> }
      | null;
    const user = body?.messages?.find((m) => m.role === "user");
    const content = user?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
    }
    return "";
  }
}

/** Build a valid plan. */
export function makePlan(over: {
  action?: { function: string; params?: Record<string, unknown> } | null;
  paused?: boolean;
  complete?: boolean;
  description?: string;
  overview?: string;
  snapshotTabs?: string[];
  /** next_step_detail.read_whole_page, written as given (a model may send the string "true"). */
  readWholePage?: unknown;
  /** For several actions in one round (executed in array order). */
  actions?: Array<{ function: string; params?: Record<string, unknown> }>;
  /** next_step_detail.path — what the deadlock test reads. */
  path?: string;
  /** current_executing_step.status, to reproduce the shape of "the model claims the previous step completed". */
  currentStatus?: string;
  /** next_step_detail.pause_kind: does it need an answer, or a person working the page? */
  pauseKind?: string;
  /** page_abstract: the model's summary of the whole current page. */
  pageAbstract?: string;
} = {}): Record<string, unknown> {
  const next: Record<string, unknown> = {
    path: over.path ?? "1.1",
    description: over.description ?? "next step",
    status: "[NEXT STEP]",
    is_paused: over.paused ?? false,
  };
  if (over.snapshotTabs) {
    next.snapshot_tabs = over.snapshotTabs;
  }
  if (over.pauseKind) {
    next.pause_kind = over.pauseKind;
  }
  if (over.readWholePage !== undefined) {
    next.read_whole_page = over.readWholePage;
  }
  // The contract holds only action_calls (an array). makePlan's action is the singular form,
  // wrapped here into a single-element array; use actions for several.
  if (over.actions) {
    next.action_calls = over.actions;
  } else if (over.action !== null) {
    next.action_calls = [
      over.action ?? {
        function: "browserNavigate",
        params: { url: "https://a.test/" },
      },
    ];
  }
  return {
    ...(over.pageAbstract ? { page_abstract: over.pageAbstract } : {}),
    task_tree_overview: over.overview ?? "1. task([NEXT STEP])",
    current_executing_step: {
      path: "1",
      description: "previous step",
      status: over.currentStatus ?? "completed",
      result: "ok",
    },
    next_step_detail: next,
    all_task_is_complete: over.complete ?? false,
    complete_reason: "",
  };
}
