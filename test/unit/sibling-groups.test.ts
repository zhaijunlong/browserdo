// "A large two-dimensional sibling group" = a flattened tree. For the rule and where the threshold comes from, see helpers/sibling-groups.ts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  FLAT_GROUP_LIMIT,
  twoDimensionalGroups,
  worstFlatGroup,
} from "../helpers/sibling-groups.js";

/** One child with a position. Rows are 40 apart and 20 high, so two rows' centres differ by 40 > 0.6x20 and separate cleanly. */
const cell = (col: number, row: number) => ({
  node_name: "A",
  bbox: [40 + col * 70, 100 + row * 40, 60, 20],
  children: [],
});

/** A cols x rows grid, all under one parent. */
const grid = (cols: number, rows: number) => ({
  children: Array.from({ length: cols * rows }, (_, i) =>
    cell(i % cols, Math.floor(i / cols)),
  ),
});

test("a nav bar in one row is not a two-dimensional group — 19 links in a row is exactly that shape", () => {
  // It is the shape that produced the most "column-block jump" false alarms: 19 elements, 18 jumps, and a perfectly correct reading.
  assert.deepEqual(twoDimensionalGroups(grid(19, 1)), []);
});

test("a list running down one column is not one either — no ambiguity about which way to read", () => {
  assert.deepEqual(twoDimensionalGroups(grid(1, 16)), []);
});

test("a 7-column by 2-row section nav is two-dimensional, but nowhere near the cap", () => {
  // The shape on Bilibili's home page. Three rounds of review flagged it as "the one remaining column-block jump", and the reading was in fact correct.
  const [g] = twoDimensionalGroups(grid(7, 2));
  assert.deepEqual(g, { size: 14, rows: 2, cols: 7 });
  assert.ok(g.size < FLAT_GROUP_LIMIT, `${g.size} should not hit the cap of ${FLAT_GROUP_LIMIT}`);
});

test("a flat layer of 48 children must be reported", () => {
  // Tencent News was 91 before a September 2026 kernel change. On a group like that, layered sorting degenerates into a global sort and the main column and sidebar alternate.
  const g = worstFlatGroup(grid(8, 6));
  assert.deepEqual(g, { size: 48, rows: 6, cols: 8 });
  assert.ok(g!.size > FLAT_GROUP_LIMIT, "a flat layer of 48 must exceed the cap");
});

test("a group with incomplete positions is skipped — we can only keep the original order there anyway", () => {
  const tree = {
    children: [
      { node_name: "A", bbox: [0, 0, 60, 20], children: [] },
      { node_name: "B", children: [] }, // no bbox, and no descendants to union
      { node_name: "C", bbox: [0, 40, 60, 20], children: [] },
    ],
  };
  assert.deepEqual(twoDimensionalGroups(tree), []);
});

test("a pure container takes its descendants' union, so a group is not missed for want of its own bbox", () => {
  // Plain wrappers have no bbox of their own. Without the union, the layer wrapping the grid would count as "positions incomplete".
  const wrap = (col: number, row: number) => ({ children: [cell(col, row)] });
  const tree = {
    children: Array.from({ length: 12 }, (_, i) => wrap(i % 4, Math.floor(i / 4))),
  };
  assert.deepEqual(worstFlatGroup(tree), { size: 12, rows: 3, cols: 4 });
});

test("the largest group in the whole tree is taken, not the first one encountered", () => {
  const tree = { children: [grid(2, 2), grid(5, 4), grid(3, 2)] };
  assert.equal(worstFlatGroup(tree)?.size, 20);
});
