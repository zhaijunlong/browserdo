import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { RuntimeActionNameSchema } from "../../src/runtime_types.js";
import { RuntimeVllmClient } from "../../src/runtime_vllm.js";
import { MAX_ACTIONS_PER_ROUND } from "../../src/config.js";

/**
 * The prompt given to the model must match the real action table.
 *
 * This chain breaks easily and breaks silently: add an action to RuntimeActionNameSchema, forget
 * to put it in the prompt's action table, and the code is green, the tests are green, and the
 * model never learns that action exists. The other direction is worse (the prompt listing an
 * action that does not exist): the model calls it, Zod refuses it outright, and a whole round is
 * wasted.
 */

describe("the prompt and the action table agree", () => {
  let prompt: string;

  before(() => {
    const client = new RuntimeVllmClient({
      endpoint: "http://stub.invalid",
      model: "stub",
      apiKey: "stub",
    });
    // buildSystemPrompt is private (at compile time only) and can still be called at run time.
    prompt = (
      client as unknown as { buildSystemPrompt(): string }
    ).buildSystemPrompt();
    assert.ok(prompt.length > 1000, "the prompt is suspiciously short; it probably was not read");
  });

  /**
   * Each row of the action table looks like `browserXxx | when to use it | parameter requirements`.
   * Not restricted to the browser prefix: queryHistoryPage is answered by the runtime and is not a
   * browser command, but it has to be in this table too — the table is what the model picks from.
   */
  function tableActions(): string[] {
    return [...prompt.matchAll(/^([a-z][A-Za-z]+) \| /gm)].map((m) => m[1]);
  }

  it("every real action is listed in the prompt's action table (a missing one is an action the model does not know it has)", () => {
    const listed = new Set(tableActions());
    const missing = RuntimeActionNameSchema.options.filter(
      (a) => !listed.has(a),
    );
    assert.deepEqual(
      missing,
      [],
      `missing from the action table: ${missing.join(", ")} — adding an action means changing buildSystemPrompt with it`,
    );
  });

  it("the prompt's action table holds no action that does not exist (listing one makes the model call it and be refused)", () => {
    const real = new Set<string>(RuntimeActionNameSchema.options);
    const extra = tableActions().filter((a) => !real.has(a));
    assert.deepEqual(extra, [], `the action table lists actions that do not exist: ${extra.join(", ")}`);
  });

  it("no duplicate rows in the action table", () => {
    const listed = tableActions();
    const dup = listed.filter((a, i) => listed.indexOf(a) !== i);
    assert.deepEqual([...new Set(dup)], [], `listed twice: ${dup.join(", ")}`);
  });

  it("every action name used in the parameter examples really exists", () => {
    const real = new Set<string>(RuntimeActionNameSchema.options);
    const inExamples = [
      ...prompt.matchAll(/"function": "(\w+)"/g),
    ].map((m) => m[1]);
    const bad = [...new Set(inExamples)].filter((a) => !real.has(a));
    assert.deepEqual(bad, [], `the examples use actions that do not exist: ${bad.join(", ")}`);
  });

  it("the prompt no longer mentions any retired name", () => {
    // These names were renamed or removed. A leftover in the prompt teaches the model the old habits back.
    const dead = [
      "showHead",
      "browserGetWindowInfos",
      "returnAnnotateContent",
      "getComputedLabel is fine",
      "browser_take_snapshot",
    ];
    const found = dead.filter((d) => prompt.includes(d));
    assert.deepEqual(found, [], `retired names left in the prompt: ${found.join(", ")}`);
  });

  it("the old spelling of annotateContent (one d short) is gone from the prompt", () => {
    // A negative lookahead: match only the "annotateContent" not followed by a d.
    const stale = prompt.match(/annotateContent(?!_|[a-zA-Z])/g) ?? [];
    assert.deepEqual(
      stale,
      [],
      "the prompt still holds the old spelling annotateContent (the kernel's field is annotatedContent)",
    );
    assert.ok(
      prompt.includes("annotatedContent"),
      "the prompt should use the new spelling when talking about annotated content",
    );
  });

  it("the prompt uses no form that would teach the model the singular action_call", () => {
    // The contract holds only action_calls (an array). The prompt may **mention** the singular name
    // to say "there is no such field", but these two forms must not appear — they are examples and
    // the model copies them:
    //   "action_call":   -- the JSON key form
    //   action_call.     -- the property access form (action_call.params.emsn and the like)
    const teaching = [
      ...(prompt.match(/"action_call"\s*:/g) ?? []),
      ...(prompt.match(/action_call\./g) ?? []),
    ];
    assert.deepEqual(
      teaching,
      [],
      `the prompt holds singular forms the model would copy: ${teaching.join(", ")}`,
    );
  });

  it("the prompt explains the two kinds of pause and asks for pause_kind", () => {
    for (const [what, re] of [
      ["the kind where a person must work the page", /needs_human_on_page/],
      ["the kind where a person answers a question", /needs_answer/],
      ["the rule is 'something only they have', not a list of scenarios", /wants something that is theirs alone/],
      ["the rule is 'a decision that is not yours to make'", /a decision is not yours to make/],
      ["being stuck is neither", /Being stuck is neither of these/],
      ["the answer is binding afterwards", /binding for the rest of the task/],
      ["the default when it is omitted must be stated", /Leaving it out is treated as needs_human_on_page/],
    ] as const) {
      assert.match(prompt, re, `the prompt does not cover "${what}"`);
    }
  });

  it("the prompt explains the three batching rules (order, stop on failure, page-changing last)", () => {
    for (const [what, re] of [
      ["executed front to back in array order", /front to back in array order/],
      ["the most certain actions first", /high-certainty actions first/],
      ["stop at the first failure", /stops at the first failure/],
      ["page-changing actions go last", /changes the page or the tab must go last/],
      ["batching should be the default (one action a round has a cost)", /only one action per round has a cost/],
      ["a decidable rule for batching", /already have an emsn in this round annotatedContent/],
      // The annotated image draws only some of the numbers (measured: of 138 emsn, the big orange
      // search button had none), so the rule must ask annotatedContent; asking "is it visible in the
      // image" needlessly loses batches.
      ["the rule is annotatedContent, not the image", /the image labels only some of what annotatedContent lists/],
      // "Never", not "no need to": clicking first makes inputs that open a panel, such as dates,
      // impossible to type into at all.
      ["never click before typing", /never put a browserClick on the same field in front of it/],
    ] as const) {
      assert.match(prompt, re, `the prompt does not cover "${what}"`);
    }
  });

  it("the batch cap in the prompt matches the config", () => {
    // A hard-coded number while the config changed means the model is told the wrong cap forever.
    assert.match(
      prompt,
      new RegExp(`At most ${MAX_ACTIONS_PER_ROUND} per round`),
      `the prompt should state the real cap of ${MAX_ACTIONS_PER_ROUND}`,
    );
  });

  it("the field names in the output contract match the Zod schema", () => {
    // The prompt asks the model for these fields; the schema validates these fields. Get them out of step and every round fails.
    for (const field of [
      "task_tree_overview",
      "current_executing_step",
      "next_step_detail",
      "action_calls",
      "all_task_is_complete",
      "complete_reason",
    ]) {
      assert.ok(prompt.includes(field), `the prompt never mentions the required field ${field}`);
    }
  });

  it("the prompt covers the loadStatus rules", () => {
    // A model that does not know these values takes failed/timeout for arrival.
    for (const token of ["loadStatus", "formResubmission", "can_go_back"]) {
      assert.ok(prompt.includes(token), `the prompt does not cover ${token}`);
    }
  });
});
