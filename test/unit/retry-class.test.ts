// Back-off intervals are split by error class.
//
// Why: in a real run the model filled next_step_detail.status with a wrong constant, Zod
// refused it, and that error took the 60-second back-off meant for rate limits and 5xx —
// turning a 3-second round into a 63-second one. The endpoint was perfectly healthy (one
// resend went through), so waiting a minute bought nothing.
import test from "node:test";
import assert from "node:assert/strict";

import {
  RETRY_INTERVAL_MALFORMED_MS,
  RETRY_INTERVAL_MS,
  RETRY_INTERVAL_TIMEOUT_MS,
  TIMEOUT_ESCALATION,
  TIMEOUT_MAX_FACTOR,
  EndpointRefusedError,
  VllmHttpError,
  classifyRetry,
} from "../../src/runtime_vllm.js";
import { normalizeRuntimePlan } from "../../src/runtime_types.js";

const named = (name: string, message = "boom") => {
  const e = new Error(message);
  e.name = name;
  return e;
};

test("badly shaped model output -> malformed (resend at once, do not wait it out)", () => {
  assert.equal(classifyRetry(named("ZodError")), "malformed");
  assert.equal(classifyRetry(named("SyntaxError")), "malformed");
  assert.equal(
    classifyRetry(new Error("VLLM returned no valid JSON (no {...} found)")),
    "malformed",
  );
  assert.equal(
    classifyRetry(new Error("The VLLM response body was empty")),
    "malformed",
  );
  assert.equal(
    classifyRetry(new Error("Could not parse JSON out of the VLLM response")),
    "malformed",
  );
  assert.equal(
    classifyRetry(new Error("VLLM message.content is not parsable text")),
    "malformed",
  );
  // The sentence normalizeRuntimePlan throws. Rewording it without the regex quietly drops
  // the class to none and retries stop; this case makes that go red.
  assert.equal(
    classifyRetry(new Error("The VLLM result is not an object")),
    "malformed",
  );
});

test("nothing a retry can fix -> none", () => {
  assert.equal(classifyRetry(new Error("no api key configured")), "none");
  assert.equal(classifyRetry("a string is not an Error"), "none");
});

test("malformed must wait far less than overload, or the classes bought nothing", () => {
  assert.ok(
    RETRY_INTERVAL_MALFORMED_MS < RETRY_INTERVAL_MS,
    `malformed(${RETRY_INTERVAL_MALFORMED_MS}ms) should be far below overload(${RETRY_INTERVAL_MS}ms)`,
  );
  assert.ok(RETRY_INTERVAL_MALFORMED_MS <= 5_000);
});

// ---- Timeout is its own class: the deadline was too short, waiting does not help ----

test("a timeout is its own class, not overload", () => {
  // A real failure: a heavy reasoning model needed 80 seconds on a 16k-token prompt while
  // the deadline was 60. Classed as overload that means "wait 60 seconds, then try again
  // with the same 60-second deadline" — a guaranteed second failure, three retries burning
  // six minutes for nothing.
  assert.equal(classifyRetry(named("AbortError")), "timeout");
  assert.equal(
    classifyRetry(new Error("The VLLM request timed out (60000ms, glm-5.3-flash)")),
    "timeout",
  );
  assert.equal(classifyRetry(new Error("request timed out")), "timeout");
});

test("network errors stay overload — waiting genuinely helps there", () => {
  assert.equal(classifyRetry(new Error("ECONNRESET")), "overload");
  assert.equal(classifyRetry(new Error("socket hang up")), "overload");
  assert.equal(classifyRetry(new Error("fetch failed")), "overload");
});

test("a refused connection is none: the service is not running, waiting will not start it", () => {
  // 10-28: the local model proxy was down, and the task sat out a 60-second overload wait.
  assert.equal(
    classifyRetry(new EndpointRefusedError("http://127.0.0.1:8080/v1/chat/completions", "m")),
    "none",
  );
});

test("the back-off after a timeout must be short — a whole deadline was just spent", () => {
  assert.ok(
    RETRY_INTERVAL_TIMEOUT_MS < RETRY_INTERVAL_MS,
    `timeout(${RETRY_INTERVAL_TIMEOUT_MS}ms) should not reuse the overload(${RETRY_INTERVAL_MS}ms) back-off`,
  );
});

test("the deadline really does grow, and is capped", () => {
  assert.ok(TIMEOUT_ESCALATION > 1, "without growth a retry is bound to fail the same way");
  assert.ok(TIMEOUT_MAX_FACTOR > 1, "it has to be able to rise above the baseline");
  // Starting at 60s: 60 -> 90 -> 135 -> 202, capped at 240
  const base = 60_000;
  let t = base;
  const seen = [t];
  for (let i = 0; i < 3; i++) {
    t = Math.min(Math.round(t * TIMEOUT_ESCALATION), base * TIMEOUT_MAX_FACTOR);
    seen.push(t);
  }
  assert.ok(seen[1] > seen[0], "the very first retry should already get a longer deadline");
  assert.ok(
    seen.at(-1)! <= base * TIMEOUT_MAX_FACTOR,
    "growth must be capped, or one hang drags down the whole round",
  );
});

// ---- The endpoint rejected a parameter: do not retry, fail over instead ----

test("a thinking switch in extraBody the model refuses -> none (three retries stay wrong)", () => {
  // Every vendor names and values these differently and we deliberately do not map or
  // validate them, so a misconfiguration lands here. When it does, switch endpoint at once
  // rather than sitting through three 60-second overload waits.
  for (const msg of [
    "Invalid parameter: thinking.type",
    "enable_thinking is not supported for this model",
    "unsupported parameter: reasoning_effort",
    "unrecognized request argument supplied: thinking",
  ]) {
    assert.equal(
      classifyRetry(new VllmHttpError(400, msg)),
      "none",
      `should be classed none: ${msg}`,
    );
  }
});

test("a 5xx mentioning 'parameter' is not a parameter error — still worth retrying", () => {
  // Matching on wording without looking at the status code makes exactly this mistake:
  // treating the endpoint's own internal fault as our misconfiguration, giving up on retries
  // and failing over to the fallback model for nothing.
  assert.equal(
    classifyRetry(new VllmHttpError(503, "internal error parsing parameter")),
    "overload",
  );
});

test("an ordinary 4xx with no parameter wording stays none, untouched by that rule", () => {
  assert.equal(classifyRetry(new VllmHttpError(401, "unauthorized")), "none");
  assert.equal(classifyRetry(new VllmHttpError(403, "forbidden")), "none");
});

test("an exhausted quota is none even on a retryable status — it resets daily, not in a minute", () => {
  assert.equal(
    classifyRetry(new VllmHttpError(503, "Monthly quota exceeded for this key")),
    "none",
  );
});

test("a 5xx outside the retry list is none (the list, not 'any 5xx', decides)", () => {
  assert.equal(classifyRetry(new VllmHttpError(501, "not implemented")), "none");
});

test("the errors normalizeRuntimePlan really throws are malformed, not just their names", () => {
  const thrown = (input: unknown): unknown => {
    try {
      normalizeRuntimePlan(input);
    } catch (e) {
      return e;
    }
    assert.fail("normalizeRuntimePlan should have thrown");
  };
  const valid = {
    task_tree_overview: "1. a",
    current_executing_step: { path: "1", description: "d", status: "completed", result: "r" },
    next_step_detail: { path: "1.1", description: "d", status: "[NEXT STEP]", is_paused: false },
    all_task_is_complete: false,
  };
  for (const [why, input] of [
    ["next_step_detail missing", { ...valid, next_step_detail: undefined }],
    ["current_executing_step as a string", { ...valid, current_executing_step: "done" }],
    ["task_tree_overview as an array", { ...valid, task_tree_overview: ["1. a"] }],
    [
      "an action name that exists nowhere",
      {
        ...valid,
        next_step_detail: {
          ...valid.next_step_detail,
          action_calls: [{ function: "browserDoTheThing", params: {} }],
        },
      },
    ],
  ] as const) {
    assert.equal(classifyRetry(thrown(input)), "malformed", why);
  }
});

// 429 is left out of the default RETRY_STATUSES on purpose: many endpoints also send it when the
// quota is used up (browserdo.config.example.yaml, retry).
test("429 fails over at once by default", () => {
  assert.equal(classifyRetry(new VllmHttpError(429, "Too Many Requests")), "none");
});

// The network branch lists ETIMEDOUT, but the timeout regex runs first and matches "TIMEDOUT",
// so a socket connect timeout gets the timeout handling (1s wait, longer deadline) instead.
test("a socket ETIMEDOUT is a network error (overload)", () => {
  assert.equal(classifyRetry(new Error("connect ETIMEDOUT 1.2.3.4:443")), "overload");
});
