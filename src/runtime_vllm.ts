import {
  RuntimeContextState,
  RuntimePlan,
  RuntimeVllmRequest,
  normalizeRuntimePlan,
} from "./runtime_types.js";
import { appendDebugLog } from "./logger.js";
import { getVllmExtraBody, getVllmFallbacks } from "./runtime_config.js";
import fs from "node:fs";
import path from "node:path";
import { describeCoverage } from "./read_coverage.js";
import { describePageType } from "./browser-actions.js";
import { compactTaskTree } from "./runtime_task_tree.js";
import {
  LOG_PROMPT,
  MAX_ACTIONS_PER_ROUND,
  SNAPSHOT_DIR,
} from "./config.js";

interface VllmClientConfig {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  apiStyle?: "openai" | "simple_chat";
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
}

const STATIC_VLLM_ENDPOINT =
  process.env.EMBIODY_VLLM_ENDPOINT ?? "https://api.deepseek.com/chat/completions";
const STATIC_VLLM_MODEL = process.env.EMBIODY_VLLM_MODEL ?? "deepseek-chat";
const STATIC_VLLM_API_KEY = process.env.EMBIODY_VLLM_API_KEY ?? "";
const STATIC_VLLM_API_STYLE: "openai" | "simple_chat" =
  (process.env.EMBIODY_VLLM_API_STYLE as "openai" | "simple_chat" | undefined) ??
  "openai";
const STATIC_VLLM_TIMEOUT_MS = Number(
  process.env.EMBIODY_VLLM_TIMEOUT_MS ?? 60_000,
);

// Loop detection: how many repeats count as stuck (the model's own semantic judgement —
// pause at this count with no progress). Set to 3, the same as the runtime backstop
// MAX_SAME_TARGET_ROUNDS: two different numbers in the prompt would leave the model guessing
// which one applies.
const REPEAT_THRESHOLD = Math.max(
  1,
  Number(process.env.EMBIODY_REPEAT_THRESHOLD ?? 3),
);

// Retry policy: the back-off interval is split by **error class** (see RetryClass); one
// interval cannot fit all.
//
// overload (5xx in RETRY_STATUSES / network): the endpoint really is overwhelmed, and
//   waiting is the only thing that helps.
// malformed (Zod or JSON parse failure): the endpoint is fine, this one output was badly
//   shaped — measurably, one resend goes through. Applying the overload interval here costs
//   a wasted minute plus a round of budget and buys nothing.
export const RETRY_INTERVAL_MS = Number(
  process.env.EMBIODY_VLLM_RETRY_INTERVAL_MS ?? 60_000,
);
export const RETRY_INTERVAL_MALFORMED_MS = Math.max(
  0,
  Number(process.env.EMBIODY_VLLM_RETRY_INTERVAL_MALFORMED_MS ?? 1_000),
);
// Timeout: a whole deadline was just spent waiting, so waiting another round makes no sense and the back-off is short.
export const RETRY_INTERVAL_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.EMBIODY_VLLM_RETRY_INTERVAL_TIMEOUT_MS ?? 1_000),
);
/**
 * How much to grow the deadline on a timeout retry, and how far above the baseline it may go.
 *
 * A heavy reasoning model needed 80 seconds on a 16k-token prompt against a 60-second
 * deadline. Retrying on the **same** deadline fails every time and burns six minutes before
 * failing over; waiting cannot fix "it simply needs longer", only a longer deadline can.
 */
export const TIMEOUT_ESCALATION = Math.max(
  1,
  Number(process.env.EMBIODY_VLLM_TIMEOUT_ESCALATION ?? 1.5),
);
export const TIMEOUT_MAX_FACTOR = Math.max(
  1,
  Number(process.env.EMBIODY_VLLM_TIMEOUT_MAX_FACTOR ?? 4),
);

/**
 * Retry classes. They exist because the **handling differs**, not to make logs look tidy:
 *   none      do not retry, fail over immediately
 *   overload  the endpoint is overwhelmed -> wait longer and retry, same deadline
 *   malformed this one output was badly shaped -> resend at once, same deadline
 *   timeout   the deadline was too short -> resend at once, but **grow the deadline**
 */
export type RetryClass = "none" | "overload" | "malformed" | "timeout";

const MAX_RETRIES = Math.max(
  0,
  Number(process.env.EMBIODY_VLLM_MAX_RETRIES ?? 3),
);
const RETRY_STATUSES = new Set(
  (process.env.EMBIODY_VLLM_RETRY_STATUS ?? "500,502,503,504")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n)),
);

interface ModelEndpoint {
  endpoint: string;
  model: string;
  apiKey?: string;
  apiStyle: "openai" | "simple_chat";
  label: string;
  /** Extra request-body fields merged in verbatim (thinking control and the like). See getVllmExtraBody. */
  extraBody?: Record<string, unknown>;
}

/** An HTTP error carrying its status code, so the retry policy can judge it. */
export class VllmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VllmHttpError";
  }
}

/**
 * Is the endpoint saying "I do not know or accept one of the parameters you sent"?
 *
 * The test is 4xx plus parameter-ish wording. The status code alone is not enough: 429 is
 * also 4xx but that is rate limiting, not a parameter. The wording alone is not enough
 * either: a 5xx can mention "parameter" too, and that is the endpoint's own problem.
 * Known instances: GLM-5.3 refusing thinking:{type:"disabled"}, and qwen3.8-max refusing
 * enable_thinking:false.
 */
export function explainRejectedParameter(
  message: string,
  model: string,
): string {
  // Keep the vendor's own sentence — it usually names the offending parameter and value —
  // and put a way out in front of it.
  return [
    `Model ${model} rejected the request parameters. This is almost always vllm.extraBody`,
    "(or vllmFallbacks[].extraBody) in your config carrying a thinking switch this model does",
    "not support. Every vendor names and values these differently, and getting one wrong is a",
    "hard failure rather than something the model ignores. Edit the extraBody section of",
    "browserdo.config.yaml following the candidate values in its comments; when in doubt,",
    "comment the whole section out to get running first.",
    `The endpoint said: ${message}`,
  ].join("\n");
}

/**
 * Nothing is listening at the endpoint (ECONNREFUSED): the model service is not running. That
 * is not overload — waiting a minute three times does not start it — so it is classed none.
 */
export class EndpointRefusedError extends Error {
  constructor(endpoint: string, model: string) {
    super(
      `Connection refused by ${endpoint} (${model}): nothing is listening there. Is the model service running?`,
    );
    this.name = "EndpointRefusedError";
  }
}

/** Node's fetch throws "fetch failed" with the socket error in cause (an AggregateError when both IPv4 and IPv6 were tried). */
function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } })
    ?.cause;
  if (!cause) return false;
  if (cause.code === "ECONNREFUSED") return true;
  return (
    Array.isArray(cause.errors) &&
    cause.errors.length > 0 &&
    cause.errors.every((e) => e?.code === "ECONNREFUSED")
  );
}

function isRejectedParameter(error: VllmHttpError): boolean {
  if (error.status < 400 || error.status >= 500 || error.status === 429) {
    return false;
  }
  return /parameter|param|unsupported|not supported|invalid.*(field|argument|body)|unrecognized|unexpected key|enable_thinking|reasoning_effort|thinking/i.test(
    error.message,
  );
}

/** Is this error "the endpoint refused a parameter"? Used for the error wording, sharing one rule with classifyRetry. */
export function isParameterRejection(error: unknown): boolean {
  return error instanceof VllmHttpError && isRejectedParameter(error);
}

/**
 * Whether this error is worth retrying, and which RetryClass decides the wait.
 *
 *   overload  — an HTTP status in RETRY_STATUSES (default 500/502/503/504; 429 is not in it),
 *               or a network error other than a refused connection.
 *   malformed — Zod validation or JSON parsing failed.
 *   timeout   — the deadline ran out.
 * Any other HTTP status, a refused parameter, a missing key or an exhausted quota -> none:
 * retrying cannot help, fail straight over to a backup endpoint.
 */
export function classifyRetry(error: unknown): RetryClass {
  if (error instanceof VllmHttpError) {
    // The endpoint refused a parameter (usually a thinking switch in extraBody this model does
    // not take) -> three retries will not make it right. Every vendor names and values these
    // differently and we deliberately do not map or validate them, so a misconfiguration lands
    // here; when it does, fail over at once rather than sitting through three 60-second waits.
    if (isRejectedParameter(error)) {
      return "none";
    }
    if (!RETRY_STATUSES.has(error.status)) {
      return "none";
    }
    // Quota exhausted (resets daily or weekly, so retrying is pointless) -> no retry, fail over.
    if (/quota/i.test(error.message)) {
      return "none";
    }
    return "overload";
  }
  if (error instanceof EndpointRefusedError) return "none";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timeout";
    // The model did not follow the schema (missing field, wrong type, bad constant) -> resend
    if (error.name === "ZodError") return "malformed";
    // JSON.parse failed, or the output holds no valid JSON -> same thing, this output is bad
    if (error.name === "SyntaxError") return "malformed";
    if (
      /JSON|not an object|no valid JSON|could not parse|response body was empty|not parsable text/i.test(
        error.message,
      )
    ) {
      return "malformed";
    }
    // singleAttempt rewraps AbortError as a plain Error, so this sentence is how a deadline hit
    // is recognised. A socket-level ETIMEDOUT is the network's, not our deadline: left to the
    // branch below.
    if (!/ETIMEDOUT/.test(error.message) && /request timed out|timed? ?out/i.test(error.message)) {
      return "timeout";
    }
    if (
      /fetch|network|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(
        error.message,
      )
    ) {
      return "overload";
    }
  }
  return "none";
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return String(error);
  }
}

function ts(): string {
  return new Date().toLocaleTimeString("en-GB");
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Filename for the prompt/reply dump.
 *
 * **The round number must be in the filename**, so a problem at round=17 in debug.log leads
 * straight to that round's files; timestamps alone, two files per round, do not line up.
 *
 * round is optional: the MCP call path has no notion of rounds and must not error over it.
 */
export function promptDumpName(kind: string, round?: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const roundPart = round !== undefined ? `_round${round}` : "";
  return `${stamp}${roundPart}_${kind}.txt`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How many page summaries are replayed in full each round; beyond that only titles, with queryHistoryPage to fetch the rest. */
const PAGE_RECORDS_IN_FULL = 8;

/**
 * The task history page records, as fed to the model.
 *
 * The current page's summary goes in every round — it is the only reminder that "this page
 * has parts I have not seen", and the model only ever holds one screenful. History pages are
 * rationed: the most recent 8 with summaries, the rest as titles only, and a closing line
 * saying how many more can be queried. Otherwise a full 50 pages is three or four thousand
 * tokens, a quarter of the whole prompt.
 */
function renderPageRecords(state: RuntimeContextState): string[] {
  const pages = state.pages ?? [];
  if (!pages.length) return [];
  const current = pages.find((p) => p.url === state.currentPageUrl);
  const others = pages
    .filter((p) => p !== current)
    .sort((a, b) => b.lastRound - a.lastRound);
  const lines: string[] = [];
  if (current) {
    // With coverage the vague caveat becomes a measured one: which parts of which area were
    // on screen in some round. Without it (an older kernel) the caveat stays.
    const seen = current.coverage?.length
      ? describeCoverage(current.coverage, current.lastRound, true)
      : [];
    lines.push(
      seen.length
        ? `The page you are on, as you summarised it (round ${current.lastRound}; written from what you had seen, listed below):`
        : `The page you are on, as you summarised it (round ${current.lastRound}; written from the parts you had seen, so it may be incomplete):`,
      `  ${current.title || "(untitled)"} | ${current.url}`,
      `  ${current.abstract || "(you have not summarised this page yet — fill page_abstract this round)"}`,
    );
    if (seen.length) {
      lines.push(
        "  What of it has been on your screen so far, by scrolling area (positions in px from the top of that area):",
        ...seen.map((l) => `    - ${l}`),
      );
    }
  }
  if (others.length) {
    if (lines.length) lines.push("");
    lines.push("Pages this task has visited:");
    others.slice(0, PAGE_RECORDS_IN_FULL).forEach((p) => {
      lines.push(
        `  ${p.title || "(untitled)"} (rounds ${p.firstRound}-${p.lastRound})`,
        `    ${p.abstract || "(no summary)"}`,
        ...(p.coverage?.length
          ? [`    seen: ${describeCoverage(p.coverage, p.lastRound, false).join("; ")}`]
          : []),
      );
    });
    const rest = others.slice(PAGE_RECORDS_IN_FULL);
    if (rest.length) {
      lines.push(
        ...rest.map((p) => `  ${p.title || "(untitled)"} (rounds ${p.firstRound}-${p.lastRound})`),
        `  (${rest.length} of them are listed by title only; queryHistoryPage gives you their summaries)`,
      );
    }
  }
  return [lines.join("\n"), ""];
}

export class RuntimeVllmClient {
  private readonly endpoints: ModelEndpoint[];
  private readonly timeoutMs: number;
  /** Index of the endpoint in use; after failing over to a backup we stay there and never return to the primary. */
  private currentEndpointIndex = 0;

  constructor(config?: VllmClientConfig) {
    const primary: ModelEndpoint = {
      endpoint: config?.endpoint ?? STATIC_VLLM_ENDPOINT,
      model: config?.model ?? STATIC_VLLM_MODEL,
      apiKey: config?.apiKey ?? (STATIC_VLLM_API_KEY || undefined),
      apiStyle: config?.apiStyle ?? STATIC_VLLM_API_STYLE,
      label: "primary model",
      extraBody: config?.extraBody ?? getVllmExtraBody(),
    };
    this.endpoints = [primary];
    // Fallbacks come from the vllmFallbacks array in the config (any number), tried in order.
    getVllmFallbacks().forEach((f, i) => {
      this.endpoints.push({
        endpoint: f.endpoint,
        model: f.model,
        apiKey: f.apiKey,
        apiStyle: f.apiStyle ?? STATIC_VLLM_API_STYLE,
        label: `fallback model ${i + 1}`,
        // Per endpoint: a different model means a different parameter vocabulary, so a shared one is wrong at one end.
        extraBody: f.extraBody,
      });
    });
    this.timeoutMs = config?.timeoutMs ?? STATIC_VLLM_TIMEOUT_MS;
  }

  /** For the runtime to print the model and address in use at task start, to confirm the config took effect. */
  getModelInfo(): { endpoint: string; model: string } {
    return {
      endpoint: this.endpoints[0].endpoint,
      model: this.endpoints[0].model,
    };
  }

  /**
   * Write this round's prompt and the model's raw reply into snapshotDir, alongside the same
   * round's screenshots. Only when EMBIODY_LOG_PROMPT=1 — over ten thousand characters per
   * round would drown everything else if it were on by default.
   */
  private dumpPrompt(
    kind: string,
    text: string,
    round?: number,
  ): string | undefined {
    if (!LOG_PROMPT) return undefined;
    try {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      const name = promptDumpName(kind, round);
      fs.writeFileSync(path.join(SNAPSHOT_DIR, name), text, "utf8");
      return name;
    } catch {
      // A failed write must not affect the main flow.
      return undefined;
    }
  }

  /**
   * Decide: walk [primary, fallback...] in order, starting from the endpoint last used; at each
   * endpoint retry an error classifyRetry does not class "none" up to MAX_RETRIES times, waiting
   * by its class; when an endpoint runs out of retries move to the next; only when all are
   * exhausted does it throw, for the layer above to pause gracefully.
   */
  async decide(request: RuntimeVllmRequest): Promise<RuntimePlan> {
    let lastError: unknown = new Error("The VLLM request failed");
    for (let ei = this.currentEndpointIndex; ei < this.endpoints.length; ei += 1) {
      const ep = this.endpoints[ei];
      // Every new endpoint starts from the baseline deadline again — the last one being slow says nothing about this one.
      let attemptTimeoutMs = this.timeoutMs;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const plan = await this.singleAttempt(ep, request, attemptTimeoutMs);
          this.currentEndpointIndex = ei; // on success stay here; never fall back up to the primary
          return plan;
        } catch (error) {
          lastError = error;
          const retryClass = classifyRetry(error);
          const retryable = retryClass !== "none";
          // Only "the endpoint is overwhelmed" is worth waiting for; a badly shaped output and too short a deadline should both resend at once.
          const waitMs =
            retryClass === "malformed"
              ? RETRY_INTERVAL_MALFORMED_MS
              : retryClass === "timeout"
                ? RETRY_INTERVAL_TIMEOUT_MS
                : RETRY_INTERVAL_MS;
          // Too short a deadline means growing the deadline. Retrying on the same one fails deterministically.
          const nextTimeoutMs =
            retryClass === "timeout"
              ? Math.min(
                  Math.round(attemptTimeoutMs * TIMEOUT_ESCALATION),
                  this.timeoutMs * TIMEOUT_MAX_FACTOR,
                )
              : attemptTimeoutMs;
          const hasMoreAttempts = attempt < MAX_RETRIES;
          const hasMoreEndpoints = ei < this.endpoints.length - 1;
          if (retryable && hasMoreAttempts) {
            await appendDebugLog(
              "runtime_vllm",
              `${ep.label}: retryable error, waiting before retry`,
              {
                endpoint: ep.endpoint,
                model: ep.model,
                attempt: attempt + 1,
                maxRetries: MAX_RETRIES,
                retryClass,
                waitMs,
                timeoutMs: attemptTimeoutMs,
                nextTimeoutMs,
                error: errorMessage(error),
              },
            );
            console.error(
              `${RED}[${ts()}] [vllm] ${ep.label} (${ep.model}) retryable error [${retryClass}]: ${errorMessage(error)} -> retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES}${nextTimeoutMs !== attemptTimeoutMs ? `, deadline raised to ${nextTimeoutMs}ms` : ""})${RESET}`,
            );
            await sleep(waitMs);
            attemptTimeoutMs = nextTimeoutMs;
            continue;
          }
          if (retryClass === "none" && isParameterRejection(error)) {
            // A misconfigured parameter is not fixed by retrying or failing over; at least point the message at the config.
            lastError = new Error(
              explainRejectedParameter(
                error instanceof Error ? error.message : String(error),
                ep.model,
              ),
            );
          }
          if (hasMoreEndpoints) {
            this.currentEndpointIndex = ei + 1; // fail over to the next endpoint and stay there
            await appendDebugLog(
              "runtime_vllm",
              `${ep.label} failed, switching to the fallback model`,
              {
                fromModel: ep.model,
                toModel: this.endpoints[ei + 1].model,
                error: errorMessage(error),
              },
            );
            console.error(
              `${RED}[${ts()}] [vllm] ${ep.label} (${ep.model}) failed -> switching to fallback model ${this.endpoints[ei + 1].model} (reason: ${errorMessage(error).slice(0, 200)})${RESET}`,
            );
            break; // leave the retry loop and move to the next endpoint
          }
          await appendDebugLog("runtime_vllm", `${ep.label} failed with no endpoints left`, {
            error: errorMessage(error),
          });
          console.error(
            `${RED}[${ts()}] [vllm] ${ep.label} (${ep.model}) failed, no endpoints or retries left: ${errorMessage(error)}${RESET}`,
          );
          throw lastError; // the error itself, or its explanation when a parameter was refused
        }
      }
    }
    throw lastError;
  }

  /** One request (fetch + parse + Zod). Throws VllmHttpError or another error on failure. */
  private async singleAttempt(
    ep: ModelEndpoint,
    request: RuntimeVllmRequest,
    timeoutMs: number,
  ): Promise<RuntimePlan> {
    if (!ep.apiKey) {
      throw new Error(`No API key configured for the ${ep.label} (${ep.model})`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await appendDebugLog("runtime_vllm", "request started", {
        endpoint: ep.endpoint,
        model: ep.model,
        apiStyle: ep.apiStyle,
        label: ep.label,
      });
      const response = await fetch(this.buildRequestUrl(ep), {
        method: "POST",
        headers: this.buildHeaders(ep),
        body: JSON.stringify(this.buildBody(ep, request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new VllmHttpError(
          response.status,
          `VLLM HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`,
        );
      }
      const responseJson = await response.json();
      await appendDebugLog("runtime_vllm", "response received", { usage: responseJson?.usage ?? null });
      const replyFile = this.dumpPrompt(
        "reply",
        JSON.stringify(responseJson, null, 2),
        request.round,
      );
      const rawPlan = this.extractPlanPayload(responseJson);
      await appendDebugLog("runtime_vllm", "extracted plan", {
        // The dump filename goes into the log: without it, spotting a bad round still means guessing which file it was from the timestamp.
        replyFile: replyFile ?? null,
      });
      return normalizeRuntimePlan(rawPlan);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(
          `The VLLM request timed out (${timeoutMs}ms, ${ep.model})`,
        );
        await appendDebugLog("runtime_vllm", "request failed", {
          error: timeoutError.message,
        });
        throw timeoutError;
      }
      const thrown = isConnectionRefused(error)
        ? new EndpointRefusedError(ep.endpoint, ep.model)
        : error;
      await appendDebugLog("runtime_vllm", "request failed", {
        error: errorMessage(thrown),
      });
      throw thrown;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRequestUrl(ep: ModelEndpoint): string {
    if (ep.endpoint.includes("/chat/completions")) {
      return ep.endpoint;
    }

    return `${ep.endpoint.replace(/\/$/, "")}/chat/completions`;
  }

  private buildHeaders(ep: ModelEndpoint): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (ep.apiKey) {
      headers.Authorization = `Bearer ${ep.apiKey}`;
    }

    return headers;
  }

  private buildBody(
    ep: ModelEndpoint,
    request: RuntimeVllmRequest,
  ): Record<string, unknown> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(request);
    // Working out "why did the model pick that emsn" needs what it actually received. Off by default.
    this.dumpPrompt(
      "prompt",
      [systemPrompt, "===== USER =====", userPrompt].join("\n\n"),
      request.round,
    );
    // A round may look at several tabs. Each tab gets **the annotated image first, the raw one
    // right after** (the raw one only when snapshot.returnImage is on), in the same order as
    // the sections of userPrompt.
    //
    // Why both: the annotated image's number labels cover the elements they label, badly so on
    // dense controls (adjacent numbers in a calendar overlap each other). The two are pixel
    // aligned, so the model can read the covered content back off the raw one by coordinate.
    // Measured, images are 8% of the prompt, so one more adds about 8% of input.
    // A tab without a picture contributes none; the prompt says which sections have one.
    const images = (request.observation?.snapshots ?? []).flatMap((shot) =>
      shot.annotatedImage
        ? [
            `data:image/png;base64,${shot.annotatedImage}`,
            ...(shot.image ? [`data:image/png;base64,${shot.image}`] : []),
          ]
        : [],
    );

    if (ep.apiStyle === "openai") {
      const userContent: Array<Record<string, unknown>> = [];
      for (const url of images) {
        userContent.push({ type: "image_url", image_url: { url } });
      }
      userContent.push({ type: "text", text: userPrompt });

      return {
        model: ep.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        // Last, so what the config says can override the defaults above — that is what "verbatim" should mean.
        ...(ep.extraBody ?? {}),
      };
    }

    return {
      model: ep.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: userPrompt,
          ...(images.length ? { images } : {}),
        },
      ],
      response_format: "json",
      ...(ep.extraBody ?? {}),
    };
  }

  private extractPlanPayload(responseJson: unknown): unknown {
    if (!responseJson || typeof responseJson !== "object") {
      throw new Error("The VLLM response body was empty");
    }

    const direct = responseJson as Record<string, unknown>;
    if ("task_tree_overview" in direct && "next_step_detail" in direct) {
      return direct;
    }

    const choices = direct.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = choices[0] as Record<string, unknown>;
      const message = firstChoice.message as Record<string, unknown> | undefined;
      const content = message?.content;
      return this.parsePlanFromContent(content);
    }

    if (typeof direct.content === "string") {
      return this.parsePlanFromContent(direct.content);
    }

    if (typeof direct.result === "string") {
      return this.parsePlanFromContent(direct.result);
    }

    throw new Error("Could not parse JSON out of the VLLM response");
  }

  private parsePlanFromContent(content: unknown): unknown {
    if (typeof content === "string") {
      return JSON.parse(this.extractJsonString(content));
    }

    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }

          if (item && typeof item === "object" && "text" in item) {
            return String((item as Record<string, unknown>).text ?? "");
          }

          return "";
        })
        .join("\n");

      return JSON.parse(this.extractJsonString(text));
    }

    throw new Error("VLLM message.content is not parsable text");
  }

  private extractJsonString(text: string): string {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        `VLLM returned no valid JSON (no {...} found). First 500 characters of the raw content: ${text.slice(0, 500)}`,
      );
    }

    return text.slice(start, end + 1);
  }

  private buildSystemPrompt(): string {
    return [
      "How you work: you drive a web browser through a multimodal vision-language model. The task tree is your map, a leaf node is the smallest unit of work, and you advance one leaf at a time until the task is done.",
      "",
      "[RE-JUDGE FROM THE CURRENT STATE EVERY ROUND] (highest priority: where anything below conflicts with this, this wins)",
      "1. The screenshot, annotatedContent, browser layout and previous result you get each round all describe **what the page looks like right now**. None of it is a reply to what you intended last round.",
      "2. Decide what to do this round from that state, instead of reciting the plan you made last round. The plan is your hypothesis, the state is fact; where they disagree the state wins, and you revise the task tree to match.",
      "3. If the previous batch did not finish (an action failed, or was cut off), **do not resume from the break point**. Look at the state again and reorganize this round from scratch: whatever already took effect need not be redone, whatever did not gets rescheduled. The basis is the current state, not the previous execution log.",
      "4. Likewise, an action reporting that it clicked or typed only means the command was accepted. It does not mean the page changed. What you see this round is the only authority.",
      "",
      "[DO NOT WRITE OUT YOUR REASONING]",
      "1. Give conclusions directly. Your thinking is not used: the runtime reads only the JSON and discards reasoning content on arrival.",
      "2. Every extra thousand words costs this round another twenty seconds, and the task has a round limit, so thinking longer means fewer steps you actually get to take.",
      "3. Whatever justification needs to be on record goes into current_executing_step.result and next_step_detail.description. Those two are read.",
      "",
      "[AVAILABLE ACTIONS] (the function of every element in action_calls must be one of these. The runtime executes them; you only declare them.)",
      "Action | When to use | Parameters",
      "browserNavigate | Go to a URL in the current tab, without opening a new one | params.url takes the full URL",
      "browserGoBack | Go back one step, as the browser back button does | No parameters. Check Current tab state below first: calling it while can_go_back=false always fails",
      "browserGoForward | Go forward one step | No parameters. Calling it while can_go_forward=false always fails",
      "browserReload | Reload the current page | params.bypassCache is optional; for form pages see the formResubmission note below",
      "browserStopLoading | Stop loading, when the page keeps spinning and you already see what you need | No parameters",
      "browserAddNewTab | Open a new tab in the current window | **Put the target address straight into params.url.** Without it you get about:blank, which yields no content in a screenshot and costs an extra round to navigate. Opens in the background by default, and background tabs can still be captured and operated on",
      "browserNewWindow | Open a brand-new browser window | params.url is optional",
      "browserClick | Click an element | params.emsn, copied from this round of annotatedContent. Snapshots carry no element positions, so there is no coordinate fallback",
      "browserInputText | Type text | Prefer params.emsn; params.text carries the content. **Whether to set pressEnter depends on the field**, see TWO KINDS OF INPUT FIELDS below. It also sets a SELECT line (a native dropdown; text = one of its options, exactly) and an INPUT:date / time / month / color field (text = YYYY-MM-DD / HH:MM / YYYY-MM / #rrggbb) directly, with no picker. To change words already in a field or editable area (a mail body), add one of params.before / after / replace (words copied from its value, \\n for a line break; replace with empty text deletes) or at (start / end), and params.occurrence when the words appear more than once",
      "browserPressKey | Press keys where focus is: Escape closes a popup, Tab moves on, ArrowDown then Enter picks a suggestion, Control+Z undoes | params.keys is a list such as [{\"key\": \"End\"}, {\"key\": \"ArrowLeft\", \"repeatCount\": 2}]; params.emsn focuses that element first by clicking it. Not for typing text. Copy, paste and the browser's own shortcuts are refused",
      "browserSelectEditableText | Select words in a field or editable area so a toolbar button (bold, colour, link) acts on them; click that button in the same batch | params.emsn, and one of: params.select (the words), params.from with params.to (from those words through these), or params.all=true. Words copied from its value as for browserInputText; params.occurrence (and params.toOccurrence for to) when they appear more than once",
      "browserScroll | Scroll | params.deltaY is how far: positive down, negative up, in the same pixels as the [PAGE POSITION] line (one screen is given there). params.toY is where to end up instead: 0 is the top, 999999 the bottom. What scrolls is whatever is under the pointer; to scroll a pane marked scrollable, add its params.emsn. Give deltaY or toY, not both",
      "browserMove | Hover over an element, for a menu or a tooltip that only appears under the pointer | params.emsn. Whatever appears has no number until the next round, so you cannot click it in this same batch: hover this round, act on what appeared next round",
      "browserDrag | Press on something, carry it somewhere, let go | Only for what a click cannot do: a slider, a canvas to pan, a split bar, a list that reorders. Start at params.emsn; destination is params.toEmsn, or params.toX and params.toY, or params.dx and params.dy for an offset. **Both ends must already be on screen** — the far end is not scrolled into view, so scroll first if it is not",
      "browserClosePopupBubble | Close a popup, permission bubble, dropdown or modal that is in the way | params.action must come from that popup own list of available actions, default dismiss. If the screenshot lists a popup, deal with it first; also use this when a click reports being covered",
      "browserSetAudioMuted | Mute or unmute the current tab | params.muted=true mutes, false unmutes. is_audible=true in Current tab state means the page is making sound",
      "browserWait | Wait for a navigation or a load | params.durationMs is optional, default 2000, and you observe again next round",
      "queryHistoryPage | Look through the pages this task has visited | Answered by the runtime, not the browser. params.keyword searches title, url and summary; leave it out to just page through the list. params.offset / params.limit page it (limit defaults to 10, max 20). The result reaches you next round",
      "browserCloseTab | Close the current tab | --",
      "browserCloseWindow | Close the current browser window | --",
      "browserStartHumanControl | Hand the tab to a human, for passwords, captchas, QR scans and other things only a person can do | No parameters. You almost never need to call this yourself: set is_paused=true and the runtime hands over automatically. Once handed over, everything except screenshots fails",
      "browserStopHumanControl | Take the tab back from the human and resume automation | No parameters. The runtime takes it back automatically when resuming, so you rarely need this",
      "[FIRST ROUND] If this round gives you no screenshot, because the task just started or the page is about:blank, do not try to click or type. Use browserNavigate to reach the target address, or browserAddNewTab / browserNewWindow, and let the runtime capture the next round.",
      "",
      "[TWO KINDS OF INPUT FIELDS: GETTING pressEnter WRONG BURNS MANY ROUNDS]",
      "1. **Submitting fields**, such as search boxes and address-bar-style query boxes: pressing Enter submits or navigates. Use pressEnter: true.",
      "2. **Suggestion fields**, such as origin and destination cities, dates, and anything that pops up a candidate list after you type: **pressEnter must be false**. Then, **in the new screenshot next round**, click the item you want from the candidate list. Enter usually does not submit in these fields, it only closes the list, so the value is never accepted and the page looks unchanged.",
      "3. How to tell them apart: a placeholder like Enter departure city or City or airport, or simply knowing that this site pops up a candidate list here, means it is the second kind. On travel, ticketing and map sites, city and date fields are almost always the second kind.",
      "4. **If typing into the same field twice has not taken effect, you have almost certainly mistaken the second kind for the first.** Switch to pressEnter: false and click the candidate next round. Do not type it again.",
      "5. A page often has several fields with identical placeholders; origin and destination can read exactly the same. Tell them apart by position in the screenshot and by the text beside them, not by the placeholder alone.",
      "",
      "[POPUPS AND PERMISSION BUBBLES]",
      "1. Every screenshot comes with a list of the popups blocking that tab, including their text and **which actions each one accepts**. When a click does nothing, this is the first thing to suspect.",
      "2. The five values of the browserClosePopupBubble action mean **entirely different things**; they are not synonyms:",
      "   dismiss   -- refuse, without writing to browser settings. It is counted, and after three times the site stops asking on its own. **Use this when unsure.**",
      "   ignore    -- the same, on a different counter, which trips after four times",
      "   allowOnce -- grant for this session only, not written to settings. Offered only where a session-level grant exists, which today means geolocation only",
      "   allow     -- grant **and write it into browser settings**, outliving this task",
      "   deny      -- refuse **and write it into browser settings**; the site stays denied and is never asked again",
      "3. **allow and deny leave marks that outlive the task**, which means making a long-term decision on behalf of the user. Unless the task itself is to grant a permission, always use dismiss.",
      "4. A permission prompt accepts some of the five: its availableActions says which. A \"Leave site?\" dialog (beforeUnload) accepts none, since that question is the person's: pause and let them answer. Every other popup (menus, modals, address-bar dropdowns) accepts dismiss only. Passing a value a popup does not offer is rejected, and the error lists what it does offer.",
      "",
      "[ONE ROUND CAN CARRY SEVERAL ACTIONS, AND BY DEFAULT IT SHOULD]",
      `1. next_step_detail.action_calls is an **array**, executed **front to back in array order**. A single action is an array of one; there is no singular action_call field. At most ${MAX_ACTIONS_PER_ROUND} per round, and anything beyond that is not executed.`,
      "2. **Giving only one action per round has a cost; it is not free caution.** Every round means another screenshot, another full context, and another pass of your own thinking. A round costs far more than one extra action in a batch. So the default question is whether this batch can take one more, not whether to batch at all.",
      "3. There is exactly one test: **does the next action target already have an emsn in this round annotatedContent?** If yes, same batch. If it only comes into existence once the previous action completes — a layer, a dropdown, an element on a page you have not opened yet — it goes to the next round. **Judge by annotatedContent, not by what you can see on the image**: the image labels only some of what annotatedContent lists, so a target with no number drawn on it may well have one.",
      "4. **Put the important, high-certainty actions first.** Execution stops at the first failure and everything after it is skipped, so the later an action sits, the likelier it is wasted.",
      "5. Every action in a batch bets on **the same snapshot from this round** — the image, the annotatedContent and the emsn in it are one set. The further down the list, the likelier that snapshot no longer holds, so do not pad a batch just to make it longer.",
      "6. **Anything that changes the page or the tab must go last**: browserNavigate / browserGoBack / browserGoForward / browserReload / browserAddNewTab / browserNewWindow / browserCloseTab / browserCloseWindow / browserStartHumanControl. Once they run, every emsn from this round snapshot is void, the runtime stops to observe again, and nothing after them executes.",
      "7. Batches that work: `[fill field A, fill field B, click submit]`, `[scroll, click]`, `[close the layer in the way, click the button behind it]`. A batch that does not: `[click next page, click something on the new page]`, because the second target does not exist yet, so annotatedContent has no emsn for you to give.",
      "8. **browserInputText focuses the target itself, so never put a browserClick on the same field in front of it.** It is not extra care, it breaks the typing: on a field that opens a panel when clicked, a date box for one, that click hands the focus to the panel and the typing then has nowhere to land. The runtime drops such a click and tells you it did.",
      "9. **An element number is only valid within the batch of screenshots it came from, and the browser enforces this.** A number from an earlier batch is rejected before any input is sent, because in the new batch that number points at a **different** element; this is validation, not a reminder. The runtime attaches the current batch identifier for you. What it means in practice: **to operate on a tab, that tab must have been captured this round.** A tab that was not captured is rejected, and the way out is to put its tabId in snapshot_tabs and act next round.",
      "10. **Clicked and typed only mean the command was accepted, not that the page really changed.** The JS on the page may have re-rendered right after your previous action, with no navigation and no address change. So the later an action sits in a batch, the more it has to be confirmed **one by one** in the next screenshot, rather than assumed because it reported success.",
      "",
      "[A SCREEN ASKING FOR CREDENTIALS IS NOT AN OBSTACLE, IT IS WHERE THE TASK NEEDS A HUMAN]",
      "1. When you reach **a login, a signup, a captcha, an SMS or email verification, a payment, a card binding or an identity check**: **set is_paused=true immediately and do not try to get around it.**",
      "2. **Above all, do not close it.** A login layer looks a lot like an ad layer in the way, but it is not an obstacle, it is the end of this road. Closing it and clicking what is behind will usually bring it straight back and burn many rounds, and even if you slip past, you will get stuck at the same place later.",
      "3. Do not fill it in on behalf of the user either. Even if an account or a password appears on the page, in the task description or in the history, do not type it. That belongs to the human, not to you.",
      "4. When you pause, put **what you saw** into current_executing_step.result, such as whether it is a login box or a captcha and whether it wants a phone number or a password, and put **what should happen after the human is done** into next_step_detail.description. The human hands the same tab back for you to resume, and those two sentences are the handover note you leave yourself.",
      "5. This rule outranks every rule about pushing forward. Pausing with the task unfinished is **a correct ending**, not a failure.",
      "",
      "[WHEN YOU PAUSE, SAY WHICH KIND OF HELP YOU NEED: next_step_detail.pause_kind]",
      "1. `needs_human_on_page`: **only a human can carry this step out**, because the screen wants something that is theirs alone — a credential, a code sent to them, their identity, their presence. You cannot supply it and must not try. The runtime hands the tab over so they can work in it, then asks them to say when they are done.",
      "2. `needs_answer`: **the step is yours to carry out, but a decision is not yours to make** — the task statement leaves the choice open, or the choice would spend the user's money or commit them to something. Put the question in next_step_detail.description, in one sentence a person can answer. The runtime asks them and gives you the answer; the tab stays with you.",
      "3. Ask rather than assume whenever the two readings would lead to different work. One question costs a round; a wrong assumption can cost the whole task, and an irreversible one cannot be taken back.",
      "4. Being stuck is neither of these. Do not dress up I cannot get this to work as a question for the user.",
      "5. Whatever the human answers is binding for the rest of the task. It is repeated back to you every round under Answers from the human, and it outranks anything you inferred yourself.",
      "",
      "[WHAT YOU CANNOT SEE RIGHT NOW IS NOT GONE]",
      "1. A screenshot and its annotatedContent cover **the visible part of the page only**. Anything scrolled out of view is missing from both, so a target you cannot find may simply be above or below you.",
      "2. The [PAGE POSITION] line above each element list says how tall the page is, which part this screen shows and how much is left. Lines marked scrollable are panes that scroll on their own, with how much they still hold. Read both before you conclude that something does not exist: when the page itself does not scroll, what you are missing is inside a pane.",
      "3. **If what you need is not in this round view but the summary of the current page says the page has it — or says there are parts you have not seen — do not ask a human: browserScroll towards it and read it from next round snapshot.** The runtime photographs the page after every batch, so you never ask for a snapshot yourself.",
      "   3.1 **When you do not know where on the page it is, or you need to read a whole list or article, set next_step_detail.read_whole_page to true instead of scrolling screen by screen.** Next round element list then covers the page around the screen (roughly nine screens each way) while the image stays one screen; lines off the image are marked offscreen and are acted on by emsn as usual. It makes that round several times larger, so ask once per page when searching, not every round, and not when the target is simply a scroll away.",
      "4. Pages you have left are recorded too, one summary each. Use queryHistoryPage when you need to remember what was on a page you visited earlier — going back to it costs a navigation and may lose what you have filled in, so check the record first.",
      "",
      "[VALUES ALREADY IN A FORM ARE LEFTOVERS, NOT TASK INPUT]",
      "1. A form often already holds values when the page opens: dates, cities, toggles, the current dropdown item. Those are **residue** from a previous session, not input for this task.",
      "2. Before filling anything, **check each field against the task requirements**. Change what does not match, and skip only what does. Do not treat a field as correct just because it already has a value.",
      "3. **Still less should you infer task parameters from what is on the page.** Relative expressions in the task, such as next Wednesday, tomorrow or next month, are always resolved against the Current time line at the end of the user prompt. A date on the page is not today, even if the weekday happens to line up.",
      "",
      "[SOME CHOICES AFFECT OTHER ELEMENTS, SO DO THOSE FIRST]",
      "1. Some choices change **whether other elements appear, how they display, or values that are already filled in**. Settle those **first**, then fill in the details. Getting the order wrong means filling everything again, and refilling costs several rounds.",
      "2. After changing such a choice, values you already filled **must be re-confirmed in the new screenshot**. Do not assume they survived because you typed them.",
      "3. The other way round: if a filled value has emptied or changed by itself, first consider whether you just touched one of these choices, instead of filling the same value a third time.",
      "",
      "[TABS AND SCREENSHOTS: YOU DECIDE WHAT TO LOOK AT NEXT ROUND]",
      "1. Every round you get a Current browser layout listing all windows and tabs, with tabId, title, address, whether the agent is using it, whether it is in the foreground, can_go_back and so on. This is the only authority on whether a tab exists.",
      "2. You name the tabs to capture next round in next_step_detail.snapshot_tabs, as an array of tabIds, for example \"snapshot_tabs\": [\"1193122597\", \"1193122598\"]. Copy tabIds from the layout; invented ones are rejected.",
      "3. Leaving snapshot_tabs out means the current working tab only. **Name several only when you genuinely need to compare pages side by side**, because each tab costs another image and therefore more tokens. The cap is 20.",
      "4. **Each tab is numbered independently.** emsn=5 in the first image and emsn=5 in the second are completely different elements. So whenever a round carries more than one image, every action must state which tab it targets in its own params.tabId, or the runtime cannot tell who you mean.",
      "5. With a single image params.tabId may be omitted, and the runtime uses the current working tab. Including it is never wrong.",
      "6. Background tabs can be captured and operated on as usual, with no need to bring them to the front. Bringing one forward would interrupt whoever is looking at that window.",
      "7. **Before clicking or typing, that tab must have been captured this round.** Numbers are issued with screenshots, so without a capture there are no numbers to use. To operate on a tab, put its tabId in snapshot_tabs first.",
      "8. If the page you want is not in the layout, open one with browserAddNewTab **and give the address directly in params.url**. Without it you get about:blank, which yields no content at all and costs another round to navigate.",
      "9. Blank tabs (about:blank) yield no content. The new tab page (chrome://new-tab-page) can be captured, but it holds only browser UI and helps nothing.",
      "",
      "[HOW TO READ THE RESULT OF A NAVIGATION] (browserNavigate / browserGoBack / browserGoForward / browserReload / browserAddNewTab)",
      "1. These results carry loadStatus and the real landing url. The landing url in the result is authoritative: after a redirect, the address you asked for and where the tab actually stopped are two different things.",
      "2. loadStatus=committed/titled/firstPaint/loaded all mean it arrived. Arriving shallower than requested is not a failure; same-document navigation, such as going back to an anchor, is always committed.",
      "3. loadStatus=failed means it did not land on the target: a network error, or an address that is not a navigable page at all, such as a download link or a 204. Do not retry as-is; change the URL or take another route.",
      "4. loadStatus=timeout means nothing committed before the deadline and where it stopped is unknown. Next round you must confirm the real state from a fresh screenshot, and you may never assume the navigation succeeded.",
      "5. loadStatus=formResubmission, which only browserReload produces, means this page was reached by submitting a form, and reloading would send it again, possibly as a second order or a second charge. The kernel therefore did nothing and the page is unchanged. Unless you can be sure that resubmitting is safe here, do not pass resubmitForm=true. Take another route with browserNavigate, or set is_paused=true and let a human judge.",
      "6. browserGoBack and browserGoForward fail hard when there is no history entry to go to; that is not a no-op success. Read can_go_back and can_go_forward in Current tab state first and save yourself a round that was bound to fail.",
      "",
      "[TASK TREE ENGINE]",
      "1. Every round, read task_tree_overview, the history of results and current_description_ex in full before you look at this round images and annotatedContent.",
      "2. The first thing you do each round is visual verification. Never conclude that a step is done because you acted on it earlier; you must see clear evidence in the current image.",
      "3. If the current leaf is not finished, next_step_detail must keep pointing at that same node. Do not advance to a new node. Splitting that unfinished node into children and pointing at its first child is not advancing, and is allowed (see LEAF GRANULARITY rule 4).",
      "4. Only when the current screenshot and annotatedContent clearly prove the current leaf is finished may you advance to the next leaf.",
      "5. After a click or a typing action, confirm in the next frame that the expected change really happened before marking the step completed. If you see no change, meaning the action did nothing, you may not mark it completed and you may not send the same action again. **Do not go looking for another way in, either — do not pick a different element, and do not try another route.** If the failure result names the cause, such as something covering the target or the target being off screen, fix that cause and retry the same target. Otherwise set is_paused=true and let a human look: the step you judged most reasonable is the one that is failing, and clicking around it is far likelier to hit something you did not intend than to get the step done.",
      `6. When the operation is sensitive, pause immediately with next_step_detail.is_paused=true. When you are unsure, or ${REPEAT_THRESHOLD} rounds pass without the page moving, pause as well — do not send the same thing again, and do not start trying other elements or other routes instead.`,
      "7. Advance one leaf at a time; there must be exactly one [NEXT STEP]. Continue task_tree_overview **on the tree I gave you**: the trunk and the branches already done stay verbatim, and if the tree ends with a collapsed marker, those branches were folded up by me because the steps are already done, so do not expand them again and certainly do not redo them.",
      "8. **The current node and everything after it is a plan, not a record.** Revise it every round to match what the page actually shows, while the overall goal stays unchanged: split a node, merge two, drop one that turned out to be unnecessary, add one the page turned out to require.",
      "",
      "[LEAF GRANULARITY: ONE LEAF = ONE ROUND = ONE BATCH]",
      "1. A leaf is what **can be finished in a single round**, not a single action. One leaf can hold several actions, and they go into action_calls together.",
      "2. The only test for splitting is: **do you need to look at a fresh screenshot in between?**",
      "   - The later action target **already has an emsn in this round annotatedContent**, so it belongs in the same leaf and the same batch.",
      "   - The later action target **only appears once the previous action completes**, such as a layer, a dropdown, or an element on a new page, so it must become the next leaf. It has no emsn yet, so you cannot fill one in.",
      "3. This is the same test as rule 3 of ONE ROUND CAN CARRY SEVERAL ACTIONS: what can go in one batch belongs in one leaf, and what cannot belongs in two.",
      "4. A node that turns out to need **more than one round** — by the test in rule 2 — must be **expanded one level deeper** in the tree, as 3.2.1 / 3.2.2 and so on, with next_step_detail.path pointing at the deepest level. You are not expected to foresee this when you first write the tree: the moment the page shows the node needs another round, split it there and then, in that same round.",
      "   For example, Filter for Air China flights cannot stay as 3.2. It expands into:",
      "     3.2.1 Scroll to the filter bar and open the airline layer  -> action_calls: [browserScroll, browserClick(filter button)]",
      "     3.2.2 Tick Air China in the layer and apply                -> action_calls: [browserClick(Air China), browserClick(confirm)]",
      "   Before the layer opens, the Air China option has no emsn at all, so it has to be a separate leaf.",
      "5. **Do not invent new child nodes just to look like you are making progress.** If a leaf is not moving, change method or pause. Renaming 3.2.1 to 3.2.2 and doing the same thing achieves nothing, and the runtime can see the path changing while the page does not.",
      "",
      "[THE ANNOTATED IMAGE AND annotatedContent ARE COMPLEMENTARY CHANNELS, AND USING ONE ALONE WILL MISLEAD YOU]",
      "1. annotatedContent gives you **structure and text**: what contains what, what each element says, and which number it has.",
      "2. The annotated image gives you **position and appearance**: where that numbered box sits on screen, how big it is, what it looks like, and whether something covers it. **Every box in the image is drawn with its emsn**, and that number is how the two channels line up.",
      "3. When you must go back to the image:",
      "   - The element **has no text**, meaning annotatedContent shows only a line like `302 I`. An icon or a purely graphical button can only be identified visually.",
      "   - Several elements have **identical text**, such as ten Book buttons on a page or two city fields with the same placeholder. Only the image tells you which one you want.",
      "   - You need to judge **what sits beside what**, such as which price belongs to which flight row, or which date is in the departure field. Text indentation expresses containment only; it cannot express left, right, above or below.",
      "   - **A click did nothing.** Check the image first for a layer or a sticky header covering that box.",
      "   - You need to confirm **whether an action actually took effect**. Whether the value really landed in the field is fastest to see in the image.",
      "4. And the reverse: **copy numbers from annotatedContent, never read them off the image.** Where numbers are dense in the image they overlap; measured, the left navigation bar had 40/39 and 124/125 stacked on each other, so reading them visually gets them wrong. Use the image to tell **which one**, and the text to get **which number**.",
      "",
      "[HOW TO READ annotatedContent]",
      "1. One element per line, shaped `<emsn> <tag> [title] text`. A line indented with a Tab sits **inside the element on the line above**.",
      "2. A line starting with `-` is text that can only be **read, not operated on**, because it has no number. To act on it, find the numbered element that carries it.",
      "3. Inside `[]` is the accessible name or the placeholder, and what follows is the visible text. Either may be empty.",
      "4. Use emsn values from the **latest round** only. Old numbers appearing in the execution history are void and must never be copied, because in the new batch the same number points at a **different** element.",
      "5. **When a target is missing from annotatedContent, the commonest reason is that the page has not finished rendering, not that it does not exist.**",
      "   After switching a channel, opening a panel or submitting a form, a page often takes another second or two to attach the new controls. Such changes involve **no navigation and no load event**, so the snapshot may catch a half-built page.",
      "   Work through this order:",
      "   1) **browserWait first, with durationMs 2000 to 3000, and look again next round.** This is the likeliest thing to work and the cheapest.",
      "   2) Still missing: browserScroll to bring it into view.",
      "   3) Still missing: take another route, such as browserNavigate to a more specific address.",
      "   4) Only if none of that works, pause.",
      "   **Never settle for an element with a nearby number or one that merely looks close.** Adjacent numbers do not mean adjacent positions, still less similar purposes. Measured: once, with the target field not yet rendered, settling for a neighbouring number typed a city name into a text node inside a different channel button, the page navigated away, and four rounds were burnt.",
      "",
      "[BROWSER NOTES INSIDE ACTION RESULTS]",
      "1. A failure saying an emsn no longer exists, or that its frame no longer exists (no longer exists / no longer in the page): the page has changed and that number is void. Find the target again in this round screenshot and annotatedContent and use the new emsn. Never resend the same emsn unchanged.",
      "2. A failure saying the target is covered (is covered by ...): a popup, a layer or a sticky header sits on top of it. First clear it with browserClosePopupBubble, or click accept or close, or browserScroll the blocker out of the way, and then click the target. Do not retry the same emsn over and over.",
      "3. A failure saying the target could not be scrolled into view: it is outside the viewport and scrolling cannot reach it. Adjust with browserScroll, or take another route such as browserNavigate to a more specific URL.",
      "4. A failure saying the element did not take input focus: not a single character was typed, and the runtime has already retried once. If it fails again, browserWait for the page to recover before retrying.",
      "5. A failure saying the target **takes no typed text** (takes no typed text / nothing that can hold text has focus): either you clicked that same field earlier in this batch and the panel it opened took the focus, or the element cannot hold text at all. Send the browserInputText on its own, with no click in front of it. If it still refuses, that field is not typed into — open it with a single browserClick and read the value out of the panel that appears, in the next round.",
      "6. A success carrying a kernel note: the action did take effect, but the element had moved or been scrolled, which means the snapshot you worked from is stale. Next round you must go by the fresh screenshot, and must not reuse the old emsn or old coordinates.",
      "7. A failure about a missing required windowId or tabId parameter is an internal targeting problem in the runtime, not a problem with your parameters. You neither need to nor should put windowId or tabId in params; the runtime attaches them itself.",
      "",
      "[ACTIONS THAT NO LONGER EXIST, SO DO NOT USE THEM]",
      "1. waitForElement and browserWaitForElement were removed. They used to report that any element had appeared, immediately, which was false. To wait, use browserWait and confirm from the next screenshot.",
      "2. getComputedLabel and getSemanticRole were removed. The element label is right there in the title field of each node in annotatedContent, so read it. The browser has never emitted semantic roles, so do not expect to get one.",
      "3. freezeRender, unfreezeRender and manageCookies are not implemented in the browser, where they used to report success unconditionally, and were removed.",
      "4. browserStartup was renamed browserNewWindow.",
      "",
      "## Output rules",
      "Return exactly one valid JSON object each time, with no other text.",
      "",
      "## Field type constraints",
      `1. task_tree_overview must be a string; an array is not allowed. One node per line, each line starting with its own path number, as in "1." or "   -> 2.1"; never label a line anything else, such as "Round 1:". Separate lines with a one-backslash newline escape (\\n). Writing \\\\n is wrong: it decodes to the two characters backslash and n, and the whole tree becomes a single line.`,
      "2. current_executing_step must be an object; a string is not allowed.",
      "3. next_step_detail must be an object, with path, description, status and is_paused all present.",
      "4. next_step_detail.status must always equal [NEXT STEP].",
      "5. current_executing_step.status must be exactly one of completed, partial or failed.",
      "6. When is_paused=true, pause_kind must be present and must be exactly needs_human_on_page or needs_answer. Leaving it out is treated as needs_human_on_page, which hands the tab over — so if what you need is an answer, say so.",
      "7. next_step_detail.description is what the human is shown when you pause, so write it as the question or the request itself, not as a note to yourself.",
      "8. page_abstract is optional and describes **the page you are on as a whole**, not this screen. Three rules: (a) write what the page is for and what regions and controls it holds, not what happens to be in front of you; (b) **say which parts you have not seen yet**, in those words — that sentence is the only thing that later tells you the page holds more than you have looked at; (c) write it when you arrive on a page and when your understanding of it changes materially, and leave the field out otherwise, because it is kept per page and rewriting the same thing every round costs you output for nothing.",
      "9. When there is no emsn, emsn_value must still be returned explicitly as null. Omitting the field is never allowed.",
      "10. all_task_is_complete must be a boolean.",
      "11. complete_reason must be a string.",
      "12. When a field has no value yet, return a placeholder anyway: an empty string for strings, false for booleans, null for emsn_value. Object fields may not be missing.",
      "13. snapshot_tabs is optional: give an array of tabIds to look at several tabs, or omit it entirely for the current tab only. Do not pass null, and do not pass an empty array.",
      "14. action_calls must be an **array**, and a single action is an array of one. There is no action_call field, so do not use the singular. Omit the field entirely when pausing.",
      "15. read_whole_page is optional and a boolean: true makes next round capture read the page around the screen, see [WHAT YOU CANNOT SEE RIGHT NOW IS NOT GONE] 3.1. It applies to next round only; leave it out otherwise.",
      "",
      "## JSON output example, to be followed exactly",
      "```json",
      "{",
      // A newline can only be escaped **one level** here. Written as four backslashes it
      // renders into the prompt as `\\n`, and nano measurably copies that literally: the whole
      // tree becomes one line containing the text `\n` and collapsing stops working entirely.
      '  "task_tree_overview": "1. Open the target page (completed)\\n2. Search for the keyword\\n   -> 2.1 Type the keyword into the search box and submit ([NEXT STEP])\\n   -> 2.2 Filter the results\\n      -> 2.2.1 Open the filter layer\\n      -> 2.2.2 Tick the conditions in the layer and apply",',
      '  "current_executing_step": {',
      '    "path": "1",',
      '    "description": "Open the target page",',
      '    "status": "completed",',
      '    "result": "The page has fully loaded and the search box is visible."',
      "  },",
      '  "next_step_detail": {',
      '    "path": "2.1",',
      '    "description": "Type the keyword into the search box and submit",',
      '    "status": "[NEXT STEP]",',
      '    "is_paused": false,',
      '    "snapshot_tabs": ["1193122597"],',
      '    "action_calls": [',
      "      {",
      '        "function": "browserInputText",',
      '        "params": {',
      '          "emsn": 12,',
      '          "text": "weather in Beijing",',
      '          "clearText": true,',
      '          "pressEnter": true',
      "        }",
      "      }",
      "    ]",
      "  },",
      '  "all_task_is_complete": false,',
      '  "complete_reason": ""',
      "}",
      "```",
      "",
      "Action parameter examples, with field names exactly as written. Every line below is **one element of the action_calls array**; put it inside the array when you use it:",
      "Several actions, executed in order, with the high-certainty ones first: json",
      '"action_calls": [ { "function": "browserInputText", "params": { "emsn": 12, "text": "user@x.com" } }, { "function": "browserInputText", "params": { "emsn": 13, "text": "\\u2022\\u2022\\u2022" } }, { "function": "browserClick", "params": { "emsn": 20 } } ]',
      "A single action is still an array: json",
      '"action_calls": [ { "function": "browserNavigate", "params": { "url": "https://www.google.com" } } ]',
      "browserClick: json. With an emsn, give only the emsn and no coordinates; when the round carries more than one image, tabId is required",
      '{ "function": "browserClick", "params": { "tabId": "1193122597", "emsn": 27, "button": "left", "clickCount": 1 } }',
      "browserInputText, submitting field such as a search box, where Enter submits: json",
      '{ "function": "browserInputText", "params": { "emsn": 15, "text": "flights from Beijing to Shanghai", "clearText": true, "pressEnter": true } }',
      "browserInputText, suggestion field such as a city or a date, where you **do not** press Enter and click the candidate next round: json",
      '{ "function": "browserInputText", "params": { "emsn": 26, "text": "Beijing", "clearText": true, "pressEnter": false } }',
      "browserScroll: json",
      '{ "function": "browserScroll", "params": { "deltaY": 600 } }',
      "browserScroll, one pane of the page (a results list, a mail list) to its bottom: json",
      '{ "function": "browserScroll", "params": { "emsn": 12, "toY": 999999 } }',
      "browserMove, to open a menu that only appears on hover: json",
      '{ "function": "browserMove", "params": { "emsn": 18 } }',
      "browserDrag, dropping one element onto another: json",
      '{ "function": "browserDrag", "params": { "emsn": 31, "toEmsn": 35 } }',
      "browserDrag, moving a slider that has nothing to drop onto, by an offset from where the press landed: json",
      '{ "function": "browserDrag", "params": { "emsn": 44, "dx": 120, "dy": 0 } }',
      "browserNavigate: json",
      '{ "function": "browserNavigate", "params": { "url": "https://www.google.com" } }',
      "browserAddNewTab: json",
      '{ "function": "browserAddNewTab", "params": { "url": "https://www.google.com" } }',
      "browserGoBack: json, no parameters",
      '{ "function": "browserGoBack", "params": {} }',
      "browserReload: json",
      '{ "function": "browserReload", "params": { "bypassCache": false } }',
      "browserClosePopupBubble: json",
      '{ "function": "browserClosePopupBubble", "params": { "action": "dismiss" } }',
      "browserSetAudioMuted: json",
      '{ "function": "browserSetAudioMuted", "params": { "muted": true } }',
      "",
      "Key rules, to be followed strictly",
      "Visual verification first: you may only mark a step completed after seeing clear evidence in the image. Before marking completed, confirm the target state was really reached. For a selection, the value must have changed and the picker or layer must have closed; for a click, the page must show the expected change. Having executed a click or a typing action never counts as completion by itself.",
      "To select an option, click the option itself: when choosing a specific option, such as a city candidate, a date cell, a dropdown item, a list entry, a radio button or a checkbox, you must click the element for that option, found by its emsn in annotatedContent. Clicking only the input or the dropdown trigger, or pressing Enter after typing, does not count as making the selection. Enter often just closes the layer without the value being accepted, leaving the page looking unchanged. **The exception is a SELECT line or an INPUT:date / time / color field**: its list or picker never shows in the element list, so set it with browserInputText instead of clicking it.",
      "Confirm required fields before submitting: before a search, a query or a form submission, confirm in the current screenshot that every required field, such as origin, destination, date or keyword, is filled in correctly. If one is empty or wrong, fill or fix it before submitting. Never click submit repeatedly with an incomplete form.",
      "Wait with browserWait: when the page is navigating or loading, when the current screenshot shows no change, or when there is temporarily nothing to act on, use browserWait rather than returning a plan with no action_calls.",
      "What emsn tells you across rounds: while the page stays (no navigation or reload), an element keeps its emsn, so the same emsn in two rounds is the same element. But a page that redraws part of itself gives the redrawn elements new numbers, and a new page numbers from 0 again, so a different emsn does not prove a different target. Judge whether you are repeating yourself by the screenshot content and the semantics: whether the element you acted on is the same target, and whether the page changed materially afterwards.",
      `Loop detection, with a repeat threshold of ${REPEAT_THRESHOLD}: before planning the next step, compare it against the execution history one by one. If you are retrying the same target even under a different emsn, the current subtask is unfinished, and the page has not changed materially, you are probably looping. Bouncing between actions in an A to B to A to B pattern, with the page cycling through a few states, is a loop too. But distinguish both from repeating the same action while the page does advance, such as clicking next page where the content really changes; that is not a loop and may continue. Once repeats reach ${REPEAT_THRESHOLD} with no progress, set is_paused=true. **Do not substitute a different element or a different route for the one that is failing**: the step you judged most reasonable is the one not working, so another way in is less likely to work and much likelier to hit something you did not intend.`,
      "Observation actions: takeSnapshot is performed by the runtime automatically and may not appear in action_calls. Name the tabs you want to see in next_step_detail.snapshot_tabs instead of treating it as an action.",
      `Pausing: a sensitive operation such as payment, login, deletion or private information requires is_paused: true immediately. So does being stuck: ${REPEAT_THRESHOLD} rounds with no progress on the page, or a failure whose cause the result does not name. is_paused and action_calls are mutually exclusive: either is_paused=false with action_calls to execute, or is_paused=true with no action_calls at all. is_paused=true together with action_calls is never allowed.`,
      "Targeting: **use emsn only**, and only values copied from this round of annotatedContent. Do not fill in x or y coordinates, because a snapshot carries no element positions and any coordinate would be a guess. If you cannot find the target, scroll, take another route, or pause.",
      "Task tree: advance one leaf at a time. Continue task_tree_overview on the tree I gave you, keeping the trunk and the finished branches verbatim; if it ends with a collapsed marker, those steps are already done, so do not expand them again and do not redo them. The current node and everything after it is a plan: revise it every round to match the page, goal unchanged.",
      "Clean output: return JSON only, with no extra text.",
      "If your task_tree_overview is an array, your current_executing_step is a string, or your next_step_detail is missing a field, the answer is treated as wrong.",
    ].join("\n");
  }

  private buildUserPrompt(request: RuntimeVllmRequest): string {
    const base = [
      `Overall user task: ${request.userTask}`,
      "",
      `Steps executed locally last round (current_description_ex): ${
        request.currentDescriptionEx || "none"
      }`,
      "",
      `Current task tree (task_tree_overview):\n${
        // Detail nodes on branches already left are folded away here: the tree grows
        // noticeably once the third level appears, and the small branches already walked are
        // worth nothing to the current decision. The runtime does the collapsing; we do not
        // rely on the model to prune.
        compactTaskTree(
          request.state.taskTreeOverview,
          request.state.latestTargetPath ?? "",
        ) || "First run, no task tree yet."
      }`,
      "",
      // The human's answer is repeated every round: said once on the round it arrives, the
      // model forgets it next round and goes back to doing what the user already ruled out.
      ...(request.state.humanAnswers.length
        ? [
            `Answers from the human (binding for the rest of the task; they outrank anything you inferred):\n${request.state.humanAnswers
              .map((a, i) => `${i + 1}. asked: ${a.question}\n   answered: ${a.answer}`)
              .join("\n")}`,
            "",
          ]
        : []),
      ...renderPageRecords(request.state),
      `History of executed steps:\n${
        request.state.history.length > 0
          ? request.state.history
              .map(
                (item) =>
                  `Round ${item.round} | ${item.path} | ${item.description} | ${item.status} | ${item.result}`,
              )
              .join("\n")
          : "No execution history yet."
      }`,
      "",
      `The same next step has now appeared ${request.state.consecutiveSameTargetCount} round(s) in a row, and this round the page is ${
        request.state.pageUnchanged
          ? "byte-for-byte identical to the last round"
          : "different from the last round"
      } (the count only rises while the page stays identical, so a rising number means no progress)`,
    ];

    const observation = request.observation;

    // The layout is refetched unconditionally every round and is the only authority on "which
    // tabs exist now". The model uses it to name the tab to look at next, and to know whether
    // browserGoBack can work.
    if (observation) {
      const lines: string[] = [
        "Current browser layout (the only authority on whether a tab exists; snapshot_tabs may only take tabIds from here):",
      ];
      for (const win of observation.layout) {
        lines.push(
          `Window windowId=${win.windowId} (${win.windowState}${win.isHidden ? ", hidden" : ""})`,
        );
        for (const tab of win.tabs) {
          const marks = [
            tab.isAgentTab ? "agent is using it" : "",
            tab.isForeground ? "foreground" : "background",
            tab.isAudible ? "audible" : "",
            tab.isMuted ? "muted" : "",
            `can_go_back=${tab.canGoBack}`,
            `can_go_forward=${tab.canGoForward}`,
          ].filter(Boolean);
          const isTarget =
            request.target?.windowId === win.windowId &&
            request.target?.tabId === tab.tabId;
          lines.push(
            `  tabId=${tab.tabId}${isTarget ? " <- current working tab" : ""} | ${tab.title || "(no title)"} | ${tab.url || "(blank)"} | ${marks.join(", ")}`,
          );
        }
      }
      base.push("", lines.join("\n"));

      if (observation.chosenByRuntime && observation.chosenReason) {
        base.push(
          "",
          `[NOTE] You did not pick the tab captured this round: ${observation.chosenReason}. To look at other tabs, name them in next_step_detail.snapshot_tabs.`,
        );
      }
      if (observation.failures.length) {
        base.push(
          "",
          [
            "Some tabs could not be captured this round. The reasons are below; change tactics accordingly and do not retry as-is:",
            ...observation.failures.map((f) => `  - ${f.reason}`),
          ].join("\n"),
        );
      }
    }

    if (!observation || observation.snapshots.length === 0) {
      return [
        ...base,
        "",
        "There is no screenshot this round, because the task just started or every tab you named is blank or gone. Use the overall task, the layout above and the history to plan or confirm the task tree, and give the next action, which is usually browserNavigate to the target address or browserAddNewTab.",
        "",
        "Return one pure JSON object.",
        ...nowTail(),
      ].join("\n");
    }

    // Several tabs: one section each, in exactly the same order as the images above.
    const shots = observation.snapshots;
    base.push(
      "",
      (shots.some((s) => s.image)
        ? `Each tab comes with two images this round: **the annotated one first, then the raw one from the same moment** (same size, pixel-aligned). There are ${shots.length} tabs, matching the ${shots.length} sections below in order.` +
          `The number labels on the annotated image cover the very things they label, so read whatever is covered at the **same position** in the raw image.`
        : `There are ${shots.filter((s) => s.annotatedImage).length} annotated images this round, matching in order the sections below that do not say [NO IMAGE].`) +
        `**Each tab is numbered independently**: emsn=5 on tab N and emsn=5 on tab M are completely different elements. Every action must state which tab it targets in its own params.tabId.`,
    );
    let imageNo = 0;
    shots.forEach((shot) => {
      const label = shot.annotatedImage ? `Image ${++imageNo}` : "[NO IMAGE]";
      base.push(
        "",
        `-- ${label} / tabId=${shot.tabId} (${shot.title || "no title"} | ${shot.url}), annotatedContent (the only trustworthy source of emsn values for this tab):`,
      );
      if (!shot.annotatedImage) {
        base.push(
          `   [NO IMAGE] No picture of this tab this round (browser note: ${shot.noImageReason ?? "none"}). The element list below is current: act on it by emsn as usual.`,
        );
      }
      // If a popup is in the way, say so first — it is very often why "the click did nothing".
      if (shot.popups.length) {
        base.push(
          `   [BLOCKED] This tab has ${shot.popups.length} popup(s) of its own in the way (permission prompts or modals), which can stop clicks from reaching the page:`,
          ...shot.popups.map(
            (pop) =>
              `      - type=${pop.type}${pop.title ? ` | title: ${pop.title}` : ""}${pop.message ? ` | text: ${pop.message}` : ""} | available actions: ${pop.availableActions.join(" / ") || "(none)"}`,
          ),
          "      Clear it with browserClosePopupBubble; params.action may only come from that popup own list of available actions above.",
        );
      }
      // An error page, a PDF or a dead renderer looks exactly like a normal capture from here,
      // and each makes the obvious next move useless.
      const kind = describePageType(shot.pageType);
      if (kind) {
        base.push(`   [PAGE TYPE: ${shot.pageType}] ${kind}`);
      }
      // The kernel hit the deadline while the page was still loading and captured anyway: the image may be half-built, and the model must be told.
      if (shot.loadingMessage) {
        base.push(
          `   [WARNING] This image was taken while the page was **still loading** (kernel note: ${shot.loadingMessage}). What you see may be half-built. If something important is missing, browserWait and look again instead of concluding the element is not there.`,
        );
      }
      // Rendered flat rather than sent as raw JSON: measurably 88% fewer characters, and
      // reasoning grows superlinearly with the prompt, so the saving is more than prefill.
      // For the format see annotated_content.ts.
      if (shot.position) base.push(`   [PAGE POSITION] ${shot.position}`);
      base.push(shot.rendered);
    });

    // Popups are scoped in three layers. Window-level ones (menus, the address bar dropdown,
    // toolbar bubbles) are reported once per window, and browser-level ones (the task manager)
    // once for the whole browser; listing them under each tab would say "the second tab has a
    // menu open" when the menu belongs to the window.
    const windowPopups = request.observation?.windowPopups;
    if (windowPopups) {
      for (const [windowId, pops] of windowPopups) {
        if (!pops.length) continue;
        base.push(
          "",
          `[BLOCKED] **Window ${windowId}** has ${pops.length} popup(s) open. They belong to the whole window rather than to one tab: menus, address-bar dropdowns, toolbar bubbles:`,
          ...pops.map(
            (pop) =>
              `   - type=${pop.type}${pop.title ? ` | title: ${pop.title}` : ""}${pop.message ? ` | text: ${pop.message}` : ""} | available actions: ${pop.availableActions.join(" / ") || "(none)"}`,
          ),
          "   It covers every tab in this window, so clear it with browserClosePopupBubble first (pass any tabId from this window).",
        );
      }
    }
    const browserPopups = request.observation?.browserPopups ?? [];
    if (browserPopups.length) {
      base.push(
        "",
        `[BLOCKED] **The browser as a whole** has ${browserPopups.length} popup(s) open, such as the task manager. They belong to no window and no tab:`,
        ...browserPopups.map(
          (pop) =>
            `   - type=${pop.type}${pop.title ? ` | title: ${pop.title}` : ""} | available actions: ${pop.availableActions.join(" / ") || "(none)"}`,
        ),
      );
    }

    base.push(
      "",
      shots.length === 1
        ? "Going strictly by this annotated image, its annotatedContent, the layout and the history above, return one pure JSON object."
        : "Going strictly by these annotated images, their annotatedContent, the layout and the history above, return one pure JSON object. Remember that each image emsn values are valid only within its own tab.",
    );
    // The current time goes **last**, for two reasons pointing the same way: prefix caching
    // matches from the start and reaches into the user prompt (measured: the system prompt is
    // 6968 tokens, yet some rounds hit 9528), so a value that changes every round truncates the
    // cacheable prefix; and the model notices content near the end more readily.
    //
    // It has to be given at all because a model has a training cut-off and does not know what
    // "now" is — other products inject the date the same way. Time is also the one fact an agent
    // cannot read off the screen: a date on a page is the site's data, not a fact about now.
    // Without it the model guesses: two seeds each took the month the calendar overlay sat on for
    // today, turning "next Wednesday" into a date two months out.
    //
    // Only the fact, never the arithmetic: "next Wednesday" is ambiguous and the model should
    // settle it from the task, not have a possibly wrong answer frozen in for it.
    base.push(...nowTail());
    return base.join("\n");
  }
}

/**
 * The tail of the user prompt: the current time.
 *
 * Pulled out because buildUserPrompt has two return paths (with and without screenshots), and
 * the one without is the first round — the round where the model plans the whole task tree and
 * most needs to know today's date.
 */
function nowTail(): string[] {
  return ["", `Current time: ${formatNow()}`];
}

/** The current time, as `2026-09-07 Monday 09:01` (local time zone). */
export function formatNow(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][at.getDay()];
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    ` ${weekday} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
