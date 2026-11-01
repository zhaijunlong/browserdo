// Find sibling groups that are both large and two-dimensional — the symptom of **a flattened tree**.
//
// Flattening gets a whole batch of reading order wrong: we sort in layers by sibling group, and
// the tree itself is the grouping. Before a September 2026 kernel change, Tencent News had a largest real DOM sibling
// group of 7, while the snapshot showed a flat layer of 91 children; layered sorting degenerated
// into one global sort over the whole viewport, and the main column and the sidebar were read a
// line at a time, alternately.
//
// **Why measure the tree's shape rather than "column-block jumps"**: the jump count peaks on the
// shape that is read most correctly (a nav bar of 19 links in one row = 19 column blocks = 18
// jumps).
//
// Positions and row grouping use the renderer's own exports rather than a copy — with different
// rules, the "rows" counted here would not be the rows the model sees.
import {
  effectiveBoxOf,
  sameLine,
  type Box,
  type RawNode,
} from "../../src/annotated_content.js";

/**
 * The cap on how many elements a two-dimensional group may hold.
 *
 * On clean corpus data (11 pages, 2026-09-14) the largest was 14, the 7-column by 2-row section
 * nav on Bilibili's home page; when flattened it runs 40-91. Set in between, leaving room on
 * both sides.
 */
export const FLAT_GROUP_LIMIT = 30;

export type FlatGroup = {
  /** How many children this group has. */
  size: number;
  /** How many rows the renderer's row rule splits them into. */
  rows: number;
  /** How many are in the widest row. */
  cols: number;
};

/**
 * Every **two-dimensional** sibling group in a tree: at least 2 rows, with at least one row
 * holding more than 1.
 *
 * A nav bar laid out in one row (19 x 1) and a list running down one column (1 x 16) do not
 * count — neither has any ambiguity about which direction to read, and flattening them cannot
 * produce a misreading.
 *
 * A group with any child whose position is unavailable is skipped entirely: the renderer gives
 * up on sorting such a group and keeps the original order anyway (see readingOrder), so "rows"
 * there mean nothing.
 */
export function twoDimensionalGroups(tree: unknown): FlatGroup[] {
  const out: FlatGroup[] = [];
  const cache = new Map<RawNode, unknown>();
  (function walk(node: RawNode): void {
    if (!node || typeof node !== "object") return;
    const children = node.children ?? [];
    if (children.length >= 2) {
      const boxes = children.map((c) => effectiveBoxOf(c, cache));
      if (boxes.every((b): b is Box => !!b)) {
        // Row grouping follows the renderer: sort by y, merge into the previous row where possible, otherwise start a new one.
        const rows: Box[][] = [];
        for (const b of [...boxes].sort((p, q) => p.y - q.y)) {
          const row = rows.at(-1);
          if (row?.some((r) => sameLine(b, r))) row.push(b);
          else rows.push([b]);
        }
        const cols = Math.max(...rows.map((r) => r.length));
        if (rows.length >= 2 && cols >= 2) {
          out.push({ size: children.length, rows: rows.length, cols });
        }
      }
    }
    for (const c of children) walk(c);
  })(tree as RawNode);
  return out;
}

/** The largest two-dimensional group, or undefined when there is none. */
export function worstFlatGroup(tree: unknown): FlatGroup | undefined {
  let worst: FlatGroup | undefined;
  for (const g of twoDimensionalGroups(tree)) {
    if (!worst || g.size > worst.size) worst = g;
  }
  return worst;
}
