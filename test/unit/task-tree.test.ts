// Task tree collapsing + plan schema normalisation + the tree's parse-rate stats.
//
// They came out of the same real failure (the Ctrip booking run that could not finish in 12 rounds):
//   - the model filled next_step_detail.status with "executing" -> the whole plan voided, a
//     60-second back-off, and a round of budget gone
//   - a coarse leaf like "3.2 filter Air China flights" takes several rounds to finish -> the
//     deadlock rule fires wrongly
import test from "node:test";
import assert from "node:assert/strict";

import {
  compactTaskTree,
  parseTaskPath,
  taskTreeParseStats,
} from "../../src/runtime_task_tree.js";
import { RuntimePlanSchema } from "../../src/runtime_types.js";

// The sample tree uses the ASCII `->`: that is what the model writes, following the prompt's
// examples. Written any other way, this file would stay green while collapsing had in fact stopped
// working — see PATH_LINE in runtime_task_tree.ts.
const TREE = [
  "1. Open Ctrip",
  "   -> 1.1 navigate to the home page (done)",
  "2. Set the flight search criteria",
  "   -> 2.1 set the origin to Shenzhen (done)",
  "      -> 2.1.1 open the origin input (done)",
  "      -> 2.1.2 type Shenzhen and pick the suggestion (done)",
  "   -> 2.2 set the destination to Beijing (done)",
  "3. Search and filter cheap Air China tickets",
  "   -> 3.1 click Search (done)",
  "      -> 3.1.1 press search (done)",
  "   -> 3.2 filter Air China flights",
  "      -> 3.2.1 open the airline overlay (done)",
  "      -> 3.2.2 tick Air China and apply([NEXT STEP])",
].join("\n");

const lines = (t: string) => t.split("\n");
const has = (t: string, frag: string) => lines(t).some((l) => l.includes(frag));

test("parseTaskPath recognises several forms and returns undefined for the rest", () => {
  assert.equal(parseTaskPath("1. Open Ctrip"), "1");
  assert.equal(parseTaskPath("   -> 3.2 filter Air China flights"), "3.2");
  assert.equal(parseTaskPath("      -> 3.2.1 open the overlay (done)"), "3.2.1");
  assert.equal(parseTaskPath("(Collapsed 3 detail nodes)"), undefined);
  assert.equal(parseTaskPath("just a sentence with no number"), undefined);
});

test("both the ASCII -> and the full-width arrow must be recognised — a mismatch makes collapsing fail silently", () => {
  assert.equal(parseTaskPath("   → 3.2 filter Air China flights"), "3.2");
  assert.equal(parseTaskPath("      → 3.2.1 open the overlay (done)"), "3.2.1");
  // Both forms mixed in one tree must be recognised too.
  const mixed = [
    "1. alpha",
    "   -> 1.1 alpha one",
    "   → 1.2 alpha two",
    "2. beta",
    "   -> 2.1 beta one",
  ].join("\n");
  assert.equal(taskTreeParseStats(mixed).unparsed, 0);
  const out = compactTaskTree(mixed, "2.1");
  assert.ok(!has(out, "1.1 alpha one"));
  assert.ok(!has(out, "1.2 alpha two"));
  assert.ok(has(out, "2.1 beta one"));
});

test("segments longer than two digits are not a path — a year and month in body text must not be deleted", () => {
  // If "2026.08 report" were taken for a level-2 node, it would be deleted whenever the current path is not 2026.
  assert.equal(parseTaskPath("2026.08 financial report"), undefined);
});

test("at 3.2.2: keep 3.2.x, keep level 2, fold away level 3 of other branches", () => {
  const out = compactTaskTree(TREE, "3.2.2");

  // Level 3 on the same branch: kept.
  assert.ok(has(out, "3.2.1 open the airline overlay"));
  assert.ok(has(out, "3.2.2 tick Air China and apply"));
  // Level 3 on other branches: folded away (this is where the saving comes from).
  assert.ok(!has(out, "3.1.1 press search"));
  assert.ok(!has(out, "2.1.1 open the origin input"));
  assert.ok(!has(out, "2.1.2 type Shenzhen and pick the suggestion"));
  // Level 2 under the same level 1: kept.
  assert.ok(has(out, "3.1 click Search"));
  // Level 2 under another level 1: folded away.
  assert.ok(!has(out, "2.1 set the origin to Shenzhen"));
  assert.ok(!has(out, "2.2 set the destination to Beijing"));
  // Level 1: always kept.
  for (const top of ["1. Open Ctrip", "2. Set the flight search criteria", "3. Search and filter cheap Air China tickets"]) {
    assert.ok(has(out, top), `a level-1 node was lost: ${top}`);
  }
});

test("at 4.1: every level 2 under 3 is folded away and only 3 remains — the user's second example", () => {
  const tree = ["3. Search", "   → 3.1 click the search button", "4. Order", "   → 4.1 fill in the passenger"].join("\n");
  const out = compactTaskTree(tree, "4.1");

  assert.ok(!has(out, "3.1 click the search button"));
  assert.ok(has(out, "3. Search"));
  assert.ok(has(out, "4.1 fill in the passenger"));
});

test("at a level-1 path: its own children are kept, every grandchild folded", () => {
  const out = compactTaskTree(TREE, "3");
  assert.ok(has(out, "3.1 click Search"));
  assert.ok(has(out, "3.2 filter Air China flights"));
  assert.ok(!has(out, "3.1.1 press search"));
  assert.ok(!has(out, "3.2.1 open the airline overlay"));
  assert.ok(!has(out, "2.1 set the origin to Shenzhen"));
});

test("a current path written with spaces or a trailing dot collapses the same as the bare path", () => {
  assert.equal(compactTaskTree(TREE, " 3.2.2. "), compactTaskTree(TREE, "3.2.2"));
});

test("a note is left after collapsing, or the model expands the folded detail all over again", () => {
  const out = compactTaskTree(TREE, "3.2.2");
  assert.match(out, /Collapsed \d+ detail node\(s\) from branches already left behind/);
  assert.match(out, /do not expand them again/);
});

test("with nothing folded, the tree is returned unchanged and no noise is added", () => {
  const flat = ["1. alpha", "2. beta", "3. gamma"].join("\n");
  assert.equal(compactTaskTree(flat, "2"), flat);
});

test("the fallback leans towards keeping: an empty currentPath, an empty tree, and unparsable lines all delete nothing", () => {
  assert.equal(compactTaskTree(TREE, ""), TREE);
  assert.equal(compactTaskTree("", "3.2.1"), "");

  const withProse = ["1. alpha", "note: this line carries no number", "   → 2.1 beta"].join("\n");
  assert.ok(has(compactTaskTree(withProse, "9.9"), "note: this line carries no number"));
});

test("an ancestor node is never folded away by itself", () => {
  const out = compactTaskTree(TREE, "3.2.2");
  assert.ok(has(out, "3. Search and filter cheap Air China tickets"));
  assert.ok(has(out, "3.2 filter Air China flights"));
});

// ---- status normalisation ----

const plan = (status: unknown) => ({
  task_tree_overview: "1. alpha",
  current_executing_step: { path: "1", description: "alpha", status: "completed", result: "" },
  next_step_detail: {
    path: "1.1",
    description: "beta",
    status,
    is_paused: false,
    coordinate_source: "annotatedContent",
    coordinate_reasoning: {
      need_coordinate: false,
      trigger_reason: "",
      emsn_checked: false,
      emsn_value: null,
      annotatedContent_lookup: "",
    },
    action_calls: [{ function: "browserScroll", params: { deltaY: 100 } }],
  },
  all_task_is_complete: false,
});

test("status written as \"executing\" does not void the whole plan — this is what cost that wasted 60 seconds", () => {
  const parsed = RuntimePlanSchema.parse(plan("executing"));
  assert.equal(parsed.next_step_detail.status, "[NEXT STEP]");
  // The plan itself must survive intact, with the actions not lost.
  assert.equal(parsed.next_step_detail.action_calls?.[0]?.function, "browserScroll");
});

test("a missing status, or one of another type, is normalised too", () => {
  for (const bad of [undefined, null, 42, { a: 1 }]) {
    assert.equal(
      RuntimePlanSchema.parse(plan(bad)).next_step_detail.status,
      "[NEXT STEP]",
    );
  }
});

test("normalisation applies only to zero-information fields: a wrong is_paused must still be refused", () => {
  const bad = plan("[NEXT STEP]");
  (bad.next_step_detail as { is_paused: unknown }).is_paused = "false";
  assert.throws(() => RuntimePlanSchema.parse(bad));
});

// ---- normalising a literal newline ----

test("the model writing a newline as the literal \\n (measured on nano) -> normalised into a real newline so the tree splits again", () => {
  const oneLine = "1. alpha\\n   -> 1.1 alpha one\\n2. beta";
  const parsed = RuntimePlanSchema.parse({ ...plan("[NEXT STEP]"), task_tree_overview: oneLine });
  assert.equal(parsed.task_tree_overview.split("\n").length, 3);
  assert.equal(taskTreeParseStats(parsed.task_tree_overview).unparsed, 0);
});

test("a tree that already uses real newlines is unaffected", () => {
  const parsed = RuntimePlanSchema.parse({ ...plan("[NEXT STEP]"), task_tree_overview: TREE });
  assert.equal(parsed.task_tree_overview, TREE);
});

// ---- parse-rate observation: used to decide whether task_tree_overview should become structured data ----

test("when the model writes in the format we gave it, no line fails to yield a path", () => {
  const s = taskTreeParseStats(TREE);
  assert.equal(s.unparsed, 0);
  assert.equal(s.total, 13);
});

test("when the model changes its writing format, unparsed rises — that is the signal to go structured", () => {
  const s = taskTreeParseStats(["One. Open Ctrip", "- set the flight search criteria"].join("\n"));
  assert.equal(s.unparsed, 2);
});

test("the fold note we append ourselves is not the model's writing and does not count", () => {
  const s = taskTreeParseStats(compactTaskTree(TREE, "3.2.2"));
  assert.equal(s.unparsed, 0);
});
