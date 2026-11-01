import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dropRedundantFocusClicks,
  isBatchTerminatingAction,
  normalizeRuntimePlan,
  RuntimeActionNameSchema,
  type RuntimeActionName,
} from "../../src/runtime_types.js";
import { MAX_ACTIONS_PER_ROUND } from "../../src/config.js";

/**
 * Several actions in one round: the contract and the batch-termination rules.
 *
 * Batching is worth it because it saves a model round trip and 3-6 seconds of waiting per round
 * (a four-field form goes from 4 rounds to 1). The cost is that every action in a batch bets on
 * **the same snapshot**, and the later it is the likelier that snapshot no longer holds. So the
 * rules are entirely about when it must stop.
 */

function planWith(next: Record<string, unknown>): Record<string, unknown> {
  return {
    task_tree_overview: "1. task([NEXT STEP])",
    current_executing_step: {
      path: "1",
      description: "previous step",
      status: "completed",
      result: "ok",
    },
    next_step_detail: {
      path: "1.1",
      description: "next step",
      status: "[NEXT STEP]",
      is_paused: false,
      ...next,
    },
    all_task_is_complete: false,
    complete_reason: "",
  };
}

const call = (fn: string, params: Record<string, unknown> = {}) => ({
  function: fn,
  params,
});

describe("action_calls: the contract holds only the array shape", () => {
  it("an array is taken as is, order preserved (execution follows that order)", () => {
    const p = normalizeRuntimePlan(
      planWith({
        action_calls: [
          call("browserInputText", { emsn: 1, text: "a" }),
          call("browserInputText", { emsn: 2, text: "b" }),
          call("browserClick", { emsn: 3 }),
        ],
      }),
    );
    assert.deepEqual(
      p.next_step_detail.action_calls?.map((c) => c.function),
      ["browserInputText", "browserInputText", "browserClick"],
    );
  });

  it("one action is a single-element array", () => {
    const p = normalizeRuntimePlan(
      planWith({ action_calls: [call("browserWait", { durationMs: 100 })] }),
    );
    assert.equal(p.next_step_detail.action_calls?.length, 1);
  });

  it("a bare object from the model is accepted too — normalisation, not a second contract", () => {
    const p = normalizeRuntimePlan(
      planWith({ action_calls: call("browserWait", {}) }),
    );
    assert.deepEqual(
      p.next_step_detail.action_calls?.map((c) => c.function),
      ["browserWait"],
    );
  });

  it("the old field name action_call is accepted and moved to action_calls", () => {
    // The singular field is gone from the contract; this only stops one mistyped field name costing a whole round.
    const p = normalizeRuntimePlan(
      planWith({ action_call: call("browserWait", {}) }),
    );
    assert.deepEqual(
      p.next_step_detail.action_calls?.map((c) => c.function),
      ["browserWait"],
    );
    assert.equal(
      (p.next_step_detail as Record<string, unknown>).action_call,
      undefined,
      "after moving it, drop the old field rather than keeping two copies",
    );
  });

  it("when both fields are given, action_calls wins", () => {
    const p = normalizeRuntimePlan(
      planWith({
        action_calls: [call("browserClick", { emsn: 1 })],
        action_call: call("browserWait", {}),
      }),
    );
    assert.deepEqual(
      p.next_step_detail.action_calls?.map((c) => c.function),
      ["browserClick"],
    );
  });

  it("an empty array -> counts as no actions (the \"no actions this round\" path, not executing zero)", () => {
    const p = normalizeRuntimePlan(planWith({ action_calls: [] }));
    assert.equal(p.next_step_detail.action_calls, undefined);
  });

  it("omitting the field is legal (a pause should omit it)", () => {
    const p = normalizeRuntimePlan(planWith({ is_paused: true }));
    assert.equal(p.next_step_detail.action_calls, undefined);
  });

  it("any invalid action name in the batch -> Zod refuses the whole batch", () => {
    assert.throws(() =>
      normalizeRuntimePlan(
        planWith({
          action_calls: [call("browserClick", { emsn: 1 }), call("madeUpAction")],
        }),
      ),
    );
  });

  it("any deleted action in the batch -> the whole batch is intercepted into a pause", () => {
    // Later actions usually depend on the effect of earlier ones, and letting a partial batch through is worse than stopping it.
    const p = normalizeRuntimePlan(
      planWith({
        action_calls: [
          call("browserClick", { emsn: 1 }),
          call("browserWaitForElement", { emsn: 2 }),
        ],
      }),
    );
    assert.equal(p.next_step_detail.is_paused, true);
    assert.equal(p.next_step_detail.action_calls, undefined);
    assert.match(p.next_step_detail.description, /not implemented in the kernel/);
  });
});

describe("isBatchTerminatingAction: which actions must be followed by a stop", () => {
  // Two kinds of reason to stop:
  //   the page changed -> every emsn in the previous snapshot is void
  //   a tab's ownership or existence changed -> what the later actions act on is gone
  // "might change the page" is not one of them: click and inputText do that constantly and carry on.
  const terminating: RuntimeActionName[] = [
    "browserNavigate",
    "browserGoBack",
    "browserGoForward",
    "browserReload",
    "browserAddNewTab",
    "browserNewWindow",
    "browserCloseTab",
    "browserCloseWindow",
    "browserStartHumanControl",
  ];

  for (const fn of terminating) {
    it(`must stop after ${fn}`, () => {
      assert.equal(isBatchTerminatingAction(fn), true);
    });
  }

  const continuable: RuntimeActionName[] = [
    "browserClick",
    "browserInputText",
    // Like typing: Enter may submit, but a page that navigates fails the next stale number hard.
    "browserPressKey",
    // Selecting changes nothing; the toolbar click that acts on it comes next.
    "browserSelectEditableText",
    "browserScroll",
    // Usually one step of several: walking the pointer along a menu path, pushing a slider
    // over in stages. What they cannot do in the same batch is act on something that only
    // appeared because of them — that has no number until the next snapshot.
    "browserMove",
    "browserDrag",
    "browserWait",
    "browserStopLoading",
    "browserSetAudioMuted",
    "browserClosePopupBubble",
    "browserStopHumanControl",
    // Does not touch the browser; only reads the task history page records, so neither the page nor the tabs moved.
    "queryHistoryPage",
  ];

  for (const fn of continuable) {
    it(`may carry on after ${fn}`, () => {
      assert.equal(isBatchTerminatingAction(fn), false);
    });
  }

  it("every action in the table falls into one of the two groups above (a new action must declare itself)", () => {
    const covered = new Set<string>([...terminating, ...continuable]);
    const missing = (RuntimeActionNameSchema.options as string[]).filter(
      (a) => !covered.has(a),
    );
    assert.deepEqual(
      missing,
      [],
      `an action was added without saying whether it terminates the batch: ${missing.join(", ")}`,
    );
  });
});

describe("dropping the click in \"click this box then type into it\"", () => {
  const c = (fn: string, emsn?: unknown) =>
    ({ function: fn, params: emsn === undefined ? {} : { emsn } }) as never;

  it("an adjacent click(X) + inputText(X): the click goes, the input stays", () => {
    const { batch, dropped } = dropRedundantFocusClicks([
      c("browserClick", 61),
      c("browserInputText", 61),
      c("browserClick", 35),
    ]);
    assert.deepEqual(dropped, ["61"]);
    assert.deepEqual(
      batch.map((x) => x.function),
      ["browserInputText", "browserClick"],
    );
  });

  it("a click and an input on different elements -> left alone", () => {
    const { batch, dropped } = dropRedundantFocusClicks([
      c("browserClick", 60),
      c("browserInputText", 61),
    ]);
    assert.deepEqual(dropped, []);
    assert.equal(batch.length, 2);
  });

  it("another action in between -> left alone (\"open something, do something else, come back and type\" is a legitimate batch)", () => {
    const { batch, dropped } = dropRedundantFocusClicks([
      c("browserClick", 61),
      c("browserScroll"),
      c("browserInputText", 61),
    ]);
    assert.deepEqual(dropped, []);
    assert.equal(batch.length, 3);
  });

  it("a number and a string count as the same element", () => {
    const { dropped } = dropRedundantFocusClicks([
      c("browserClick", "61"),
      c("browserInputText", 61),
    ]);
    assert.deepEqual(dropped, ["61"]);
  });

  // Each tab numbers its elements independently, so emsn 61 on tab A and emsn 61 on tab B are
  // different elements; the click on A is not redundant.
  it("the same emsn on two different tabs is not the same element", () => {
    const { dropped } = dropRedundantFocusClicks([
      { function: "browserClick", params: { emsn: 61, tabId: "1001" } },
      { function: "browserInputText", params: { emsn: 61, tabId: "1002", text: "x" } },
    ]);
    assert.deepEqual(dropped, []);
  });

  it("actions without an emsn are not treated as the same element — otherwise \"click what has focus then type\" would be dropped", () => {
    const { dropped } = dropRedundantFocusClicks([
      c("browserClick"),
      c("browserInputText"),
    ]);
    assert.deepEqual(dropped, []);
  });
});

describe("the batch cap comes from the config", () => {
  it("defaults to 10", () => {
    assert.equal(MAX_ACTIONS_PER_ROUND, 10);
  });

  it("is at least 1 (configuring 0 or a negative must not make a round do nothing)", () => {
    assert.ok(MAX_ACTIONS_PER_ROUND >= 1);
  });
});
