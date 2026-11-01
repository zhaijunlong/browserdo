// extraBody: pass vendor-specific parameters through into the request body verbatim.
//
// It exists for thinking control. Measured, glm-5.3-flash averages 4251 output tokens of which
// 3608 (85%) are reasoning, and our code never reads reasoning_content — it is discarded on
// arrival. Every vendor differs in parameter name, accepted values and whether it is supported at
// all (GLM-5.3 takes only reasoning_effort and cannot turn it off, Qwen uses enable_thinking, and
// a self-hosted vLLM needs another chat_template_kwargs wrapper), so nothing here is mapped or
// validated.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfigFile } from "../../src/runtime_config.js";
import {
  RuntimeVllmClient,
  VllmHttpError,
  classifyRetry,
  explainRejectedParameter,
  formatNow,
  isParameterRejection,
  promptDumpName,
} from "../../src/runtime_vllm.js";
import type { RuntimeVllmRequest } from "../../src/runtime_types.js";

const REQ = {
  userTask: "test",
  currentDescriptionEx: "none",
  state: {
    taskTreeOverview: "1. alpha",
    history: [],
    currentDescriptionEx: "",
    pageUnchanged: false,
    humanAnswers: [],
    pages: [],
    consecutiveSameTargetCount: 0,
  },
} as RuntimeVllmRequest;

/** buildBody is private (at compile time only) and can still be called at run time. */
const body = (extraBody?: Record<string, unknown>, apiStyle: "openai" | "simple_chat" = "openai") => {
  const client = new RuntimeVllmClient({
    endpoint: "http://stub.invalid",
    model: "stub",
    apiKey: "stub",
    apiStyle,
    extraBody,
  });
  const ep = (
    client as unknown as { endpoints: Array<Record<string, unknown>> }
  ).endpoints[0];
  return (
    client as unknown as {
      buildBody(ep: unknown, r: RuntimeVllmRequest): Record<string, unknown>;
    }
  ).buildBody(ep, REQ);
};

describe("extraBody pass-through", () => {
  it("appears in the request body verbatim, neither renamed nor wrapped", () => {
    const b = body({ reasoning_effort: "low" });
    assert.equal(b.reasoning_effort, "low");
  });

  it("a nested object passes through verbatim too (exactly the shape a self-hosted vLLM wants)", () => {
    const b = body({ chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  });

  it("with nothing configured, nothing is added (a vendor parameter must not appear from nowhere)", () => {
    const b = body(undefined);
    assert.ok(!("reasoning_effort" in b));
    assert.ok(!("thinking" in b));
    assert.ok(!("enable_thinking" in b));
  });

  it("the simple_chat path passes through as well — not just the openai half", () => {
    const b = body({ enable_thinking: false }, "simple_chat");
    assert.equal(b.enable_thinking, false);
  });

  it("can override our own defaults (which is what \"pass-through\" should mean)", () => {
    // For instance an endpoint that does not accept {type:"json_object"} must be fixable from the
    // config rather than by coming back to change the code.
    const b = body({ response_format: { type: "text" } });
    assert.deepEqual(b.response_format, { type: "text" });
  });

  it("passing through does not disturb messages (system first, user second; a stable prefix is what makes caching possible)", () => {
    const b = body({ reasoning_effort: "low" });
    const msgs = b.messages as Array<{ role: string }>;
    assert.equal(msgs[0].role, "system");
    assert.equal(msgs[1].role, "user");
  });
});

describe("the prompt dump carries the round number", () => {
  // Why: with only a timestamp, a problem at round=17 in debug.log meant matching timestamps by
  // hand in browser_data — two files per round and a dozen seconds between adjacent rounds.
  it("the round appears in the filename", () => {
    const name = promptDumpName("prompt", 17);
    assert.match(name, /_round17_prompt\.txt$/, name);
  });

  it("a round's prompt and reply line up", () => {
    // That is exactly how it is used while troubleshooting: debug.log says round=17 is wrong, so
    // find that round's input and output together in browser_data.
    for (const kind of ["prompt", "reply"]) {
      assert.match(promptDumpName(kind, 17), /_round17_/);
    }
  });

  it("produces a valid filename without a round too (the MCP path has none)", () => {
    const name = promptDumpName("prompt");
    assert.match(name, /_prompt\.txt$/);
    assert.ok(!name.includes("undefined"), name);
    assert.ok(!name.includes("_round"), name);
  });

  it("the filename holds no colons or dots, which Windows will not accept", () => {
    // An ISO timestamp used as a filename simply cannot be written on Windows.
    const name = promptDumpName("prompt", 3);
    assert.ok(!name.includes(":"), name);
    assert.equal(name.split(".").length, 2, `only the extension's dot should be there: ${name}`);
  });

  it("the round arrives through RuntimeVllmRequest (and omitting it does not blow up)", () => {
    // round is optional: the MCP path has no notion of rounds and must not error over it.
    const client = new RuntimeVllmClient({
      endpoint: "http://stub.invalid",
      model: "stub",
      apiKey: "stub",
    });
    const build = (
      client as unknown as {
        buildBody(ep: unknown, r: RuntimeVllmRequest): Record<string, unknown>;
      }
    ).buildBody.bind(client);
    const ep = (client as unknown as { endpoints: unknown[] }).endpoints[0];
    assert.doesNotThrow(() => build(ep, REQ));
    assert.doesNotThrow(() => build(ep, { ...REQ, round: 7 }));
  });
});

describe("the current time must reach the model", () => {
  // A model has a training cut-off and fundamentally does not know what "now" is. ChatGPT and
  // Gemini "knowing today's date" is the product injecting it into the prompt, not a model
  // capability. Time is also the one fact an agent cannot read off the screen — a date on a page is
  // the site's data, not a fact about now.
  //
  // Measured cost of omitting it: the model guesses from the page. On 2026-09-07 two rounds each
  // took the month the calendar overlay sat on for today, turning "next Wednesday" into 2026-11-11
  // (two months out) and failing the task.
  const userPrompt = () =>
    (
      new RuntimeVllmClient({
        endpoint: "http://stub.invalid",
        model: "stub",
        apiKey: "stub",
      }) as unknown as { buildUserPrompt(r: RuntimeVllmRequest): string }
    ).buildUserPrompt(REQ);

  it("the user prompt holds the current time", () => {
    assert.match(userPrompt(), /Current time: \d{4}-\d{2}-\d{2} (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{2}:\d{2}/);
  });

  it("it goes **last** — the time changes every round, and putting it earlier truncates the cacheable prefix", () => {
    // Prefix caching matches from the start, and the beginning of the user prompt is hit too:
    // measured, 6968 is the system prompt's size while some rounds hit 9528 / 9016, which means it
    // reached into the user prompt.
    const lines = userPrompt().trimEnd().split("\n");
    assert.match(lines.at(-1)!, /^Current time: /, `the last line is "${lines.at(-1)}"`);
  });

  it("does not appear in the system prompt (that would destroy the whole prefix cache)", () => {
    const sp = (
      new RuntimeVllmClient({
        endpoint: "http://stub.invalid",
        model: "stub",
        apiKey: "stub",
      }) as unknown as { buildSystemPrompt(): string }
    ).buildSystemPrompt();
    assert.ok(!sp.includes("Current time:"), "the system prompt must be stable byte for byte");
  });

  it("gives the fact and does not work out which day \"next Wednesday\" is", () => {
    // "Next Wednesday" is ambiguous (this week's, or the following week's) and the model should
    // settle it from the task. Doing the arithmetic for it freezes the ambiguity into a possibly
    // wrong answer.
    const p = userPrompt();
    for (const word of ["next Wednesday", "next week", "tomorrow"]) {
      assert.ok(!p.includes(word), `the prompt must not resolve relative time for the model (found "${word}")`);
    }
  });

  it("gets the weekday right", () => {
    // 2026-09-07 was a Monday — the day of that failure, kept here as an anchor.
    assert.match(formatNow(new Date(2026, 8, 7, 9, 1)), /^2026-09-07 Monday 09:01$/);
    assert.match(formatNow(new Date(2026, 8, 9, 0, 0)), /^2026-09-09 Wednesday 00:00$/);
  });
});

describe("the wording when a parameter is refused", () => {
  it("points at the config file rather than dumping a raw HTTP error", () => {
    // Measured: thinking:{type:"auto"} was refused and the user saw "the primary model failed with
    // no endpoints left" plus a wall of raw HTTP 400, and had to work out for themselves that auto
    // was unsupported.
    const m = explainRejectedParameter(
      "Unsupported thinking type for the current model: auto",
      "dola-seed-2-1-turbo",
    );
    assert.match(m, /extraBody/);
    assert.match(m, /browserdo\.config\.yaml/);
    assert.match(m, /dola-seed-2-1-turbo/);
    assert.match(m, /Unsupported thinking type/, "keep the vendor's own words — they name the offending value");
  });

  it("recognises a parameter refusal without misclassifying rate limiting as one", () => {
    assert.ok(
      isParameterRejection(
        new VllmHttpError(400, "Unsupported thinking type for the current model: auto"),
      ),
    );
    assert.ok(!isParameterRejection(new VllmHttpError(429, "rate limit")));
    assert.ok(!isParameterRejection(new Error("fetch failed")));
  });

  // decide() builds the explained message into lastError, but on the last endpoint it throws the
  // original error, and with a fallback the next endpoint overwrites lastError — so the user never
  // sees the explanation. Skipped until fixed; it fails today with the raw "VLLM HTTP 400: ...".
  it("reaches the caller of decide() when the last endpoint refuses a parameter", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"Unsupported thinking type for the current model: auto"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new RuntimeVllmClient({
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: "dola-seed-2-1-turbo",
        apiKey: "stub",
      });
      await assert.rejects(() => client.decide(REQ), /browserdo\.config\.yaml/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("reading the plan out of the reply", () => {
  /** extractPlanPayload is private (at compile time only) and can still be called at run time. */
  const extract = (reply: unknown): unknown =>
    (
      new RuntimeVllmClient({
        endpoint: "http://stub.invalid",
        model: "stub",
        apiKey: "stub",
      }) as unknown as { extractPlanPayload(r: unknown): unknown }
    ).extractPlanPayload(reply);
  const caught = (reply: unknown): unknown => {
    try {
      extract(reply);
    } catch (e) {
      return e;
    }
    assert.fail("extractPlanPayload should have thrown");
  };
  const choice = (content: unknown) => ({ choices: [{ message: { content } }] });

  it("a JSON object wrapped in a code fence and prose is still found", () => {
    const got = extract(choice('Here you go:\n```json\n{"a": {"b": 1}}\n```\nDone.'));
    assert.deepEqual(got, { a: { b: 1 } });
  });

  it("content given as an array of text parts is joined and parsed", () => {
    const got = extract(choice([{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }]));
    assert.deepEqual(got, { a: 1 });
  });

  it("a body that is the plan itself passes straight through (what StubVllm relies on)", () => {
    const plan = { task_tree_overview: "1. a", next_step_detail: {} };
    assert.equal(extract(plan), plan);
  });

  // Every way a reply can be unusable must land in "malformed" (resend at once), not "none"
  // (fail over) and not "overload" (wait a minute).
  it("every unusable reply is classed malformed", () => {
    for (const [why, reply] of [
      ["no body", null],
      ["no braces at all", choice("I cannot help with that.")],
      ["cut off before any closing brace", choice('{"task_tree_overview": "1. a", "next')],
      ["cut off after an inner object", choice('{"a": {"b": 1}, "c": ')],
      ["content null (reasoning-only reply)", choice(null)],
      ["empty choices and nothing else", { choices: [] }],
      ["an object with no known field", { id: "x" }],
    ] as const) {
      assert.equal(classifyRetry(caught(reply)), "malformed", why);
    }
  });
});

describe("fallback endpoints from the config file", () => {
  const dirs: string[] = [];
  const load = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browserdo-fb-"));
    dirs.push(dir);
    const file = path.join(dir, "browserdo.config.json");
    fs.writeFileSync(file, body, "utf8");
    loadRuntimeConfigFile(file);
  };
  after(() => {
    load("{}"); // parsedConfig is module state; leave it empty for whatever runs next
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const endpoints = () =>
    (
      new RuntimeVllmClient({ endpoint: "http://p.invalid", model: "p", apiKey: "k" }) as unknown as {
        endpoints: Array<{ model: string; extraBody?: Record<string, unknown> }>;
      }
    ).endpoints;

  it("each fallback keeps its own extraBody; the primary's is not inherited", () => {
    load(
      JSON.stringify({
        vllm: { extraBody: { reasoning_effort: "low" } },
        vllmFallbacks: [
          { endpoint: "http://f1.invalid", model: "f1", apiKey: "k1" },
          { endpoint: "http://f2.invalid", model: "f2", apiKey: "k2", extraBody: { enable_thinking: false } },
        ],
      }),
    );
    const eps = endpoints();
    assert.deepEqual(eps[0].extraBody, { reasoning_effort: "low" });
    assert.equal(eps[1].extraBody, undefined, "a different model means a different vocabulary");
    assert.deepEqual(eps[2].extraBody, { enable_thinking: false });
  });

  it("an entry missing endpoint, model or apiKey is dropped, not tried", () => {
    load(
      JSON.stringify({
        vllmFallbacks: [
          { endpoint: "http://f1.invalid", model: "f1" },
          { endpoint: "http://f2.invalid", model: "f2", apiKey: "k2" },
        ],
      }),
    );
    assert.deepEqual(endpoints().map((e) => e.model), ["p", "f2"]);
  });

  it("vllmFallbacks wins over the older single vllmFallback when both are present", () => {
    load(
      JSON.stringify({
        vllmFallbacks: [{ endpoint: "http://f1.invalid", model: "list", apiKey: "k" }],
        vllmFallback: { endpoint: "http://f2.invalid", model: "single", apiKey: "k" },
      }),
    );
    assert.deepEqual(endpoints().map((e) => e.model), ["p", "list"]);
  });

  it("an extraBody that is an array is ignored rather than spread into the body", () => {
    load(JSON.stringify({ vllm: { extraBody: ["reasoning_effort", "low"] } }));
    assert.equal(endpoints()[0].extraBody, undefined);
  });
});
