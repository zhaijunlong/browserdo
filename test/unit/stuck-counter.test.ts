// The stuck counter: how many rounds in a row the same "next step" appeared with the page
// unchanged character for character.
//
// It decides when the runtime forces a pause, and both false positives and false negatives have
// cost us for real:
//   - missed: the model changed emsn every round, claimed "completed" every round, and spun on
//     the same leaf until the round budget ran out
//   - false: a date widget needs four rounds (open the calendar, change month, pick a day, close
//     the panel) and the page moves every one of them
import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRuntimeMemory } from "../../src/runtime_memory.js";
import type { RuntimePlan } from "../../src/runtime_types.js";

/** A plan that only cares about path and the self-reported status. */
const plan = (path: string, status = "partial"): RuntimePlan =>
  ({
    task_tree_overview: "1. task",
    current_executing_step: { path: "1", description: "previous step", status, result: "ok" },
    next_step_detail: { path, description: "next step", status: "[NEXT STEP]", is_paused: false },
    all_task_is_complete: false,
    complete_reason: "",
  }) as unknown as RuntimePlan;

/** Run one round: record this round's page fingerprint, then book this round's plan. */
function round(
  memory: BrowserRuntimeMemory,
  n: number,
  path: string,
  content: string | undefined,
  status?: string,
): number {
  memory.recordPageSignature(content);
  memory.updateAfterPlan(n, plan(path, status));
  return memory.getSnapshot().consecutiveSameTargetCount;
}

test("the same path with the page unchanged character for character -> rises round by round", () => {
  const m = new BrowserRuntimeMemory();
  assert.equal(round(m, 1, "2.3", "same"), 1);
  assert.equal(round(m, 2, "2.3", "same"), 2);
  assert.equal(round(m, 3, "2.3", "same"), 3);
});

test("the same path but the page changed -> does not rise; this is the date widget false positive", () => {
  const m = new BrowserRuntimeMemory();
  for (let i = 1; i <= 4; i++) {
    assert.equal(round(m, i, "2.3", `page-${i}`), 1, `round ${i}`);
  }
});

test("the page did not move but the model reports 'completed' -> rises anyway (what fooled the original implementation)", () => {
  const m = new BrowserRuntimeMemory();
  assert.equal(round(m, 1, "2.3", "same", "completed"), 1);
  assert.equal(round(m, 2, "2.3", "same", "completed"), 2);
  assert.equal(round(m, 3, "2.3", "same", "completed"), 3);
});

test("a changed path resets to 1 even with the page unmoved — expanding into child nodes is not deadlock", () => {
  const m = new BrowserRuntimeMemory();
  round(m, 1, "2.3", "same");
  assert.equal(round(m, 2, "2.3", "same"), 2);
  assert.equal(round(m, 3, "2.3.1", "same"), 1);
  assert.equal(round(m, 4, "2.3.1", "same"), 2);
});

test("no page content for this round -> treated as changed, reset to 1", () => {
  const m = new BrowserRuntimeMemory();
  round(m, 1, "2.3", "same");
  assert.equal(round(m, 2, "2.3", "same"), 2);
  // A failed capture, or the working tab not captured: not being able to see must not lean towards a forced pause.
  assert.equal(round(m, 3, "2.3", undefined), 1);
  // Capture resumes, but the fingerprint chain is broken, so two consecutive rounds are needed to reach 2 again.
  assert.equal(round(m, 4, "2.3", "same"), 1);
  assert.equal(round(m, 5, "2.3", "same"), 2);
});

test("the first round has no previous round to compare, so pageUnchanged must be false", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageSignature("same");
  assert.equal(m.getSnapshot().pageUnchanged, false);
});

test("targetRepeatIfAdopted matches the count after booking — the runtime and the prompt must not report two numbers", () => {
  const m = new BrowserRuntimeMemory();
  round(m, 1, "2.3", "same");
  m.recordPageSignature("same");
  const predicted = m.targetRepeatIfAdopted("2.3");
  m.updateAfterPlan(2, plan("2.3"));
  assert.equal(predicted, m.getSnapshot().consecutiveSameTargetCount);
});

test("an empty path takes no part in the consecutive test", () => {
  const m = new BrowserRuntimeMemory();
  round(m, 1, "", "same");
  assert.equal(round(m, 2, "", "same"), 1);
});
