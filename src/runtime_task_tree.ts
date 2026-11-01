// Collapsing the task tree: fold away the detail nodes of branches already walked, keep the trunk.
//
// With one leaf per round the tree grows a third level (3.2.1 ...), and on a long task it
// soon takes more room than the useful context, while a finished branch's detail is worth nothing
// to the current decision.
//
// The rule — a level-L node is kept iff its parent path matches the first L-1 segments of the
// current path:
//   level-1 nodes   always kept
//   at 3.2.1        3.2.x kept, 3.1 kept, 3.1.1 folded, 2.1 folded, 2 kept
//   at 4.1          4.x kept, 3.1 folded, 3 kept
//
// Done before the tree reaches the model; we do not rely on it to prune. It then writes the next
// round against the collapsed tree, which makes the collapse stick.

/**
 * The task path at the start of a line: `1.` / `-> 1.2 ` / `   -> 3.2.1 ` / `   → 3.2.1 `.
 *
 * **Both arrows must be recognised, and they must match the prompt's examples.** This once
 * accepted only `→` while the examples showed `->`, so no child path parsed, every line was kept
 * under the "when unsure, keep" fallback, and collapsing silently did nothing (11 of 15 lines).
 *
 * One or two digits per segment is deliberate: a tree never has 100 siblings, and allowing more
 * would read body text like "2026.08 report" as a path and delete it.
 */
const PATH_LINE = /^\s*(?:(?:→|->)\s*)?(\d{1,2}(?:\.\d{1,2})*)[.、)\s]/;
/**
 * How many lines of this tree yield a path, and how many do not.
 *
 * It answers one question: **should task_tree_overview become structured data?** Collapsing
 * relies on a regex reading the leading numbers of free-form text, which is reliable while the
 * model keeps to the format we gave it. A regularly non-zero unparsed means it changed style,
 * and that is the signal to go structured. Until then plain text is cheaper: the model
 * regenerates this field every round, and JSON would double the characters.
 */
export function taskTreeParseStats(tree: string): {
  total: number;
  unparsed: number;
} {
  const lines = (tree ?? "").split("\n").filter((l) => l.trim());
  const unparsed = lines.filter(
    // The fold notice we append ourselves is not the model's writing and does not count.
    (l) => parseTaskPath(l) === undefined && !l.includes(COLLAPSED_MARK),
  ).length;
  return { total: lines.length, unparsed };
}

/** Take the task path out of a line; undefined when there is none (callers must then keep the line). */
export function parseTaskPath(line: string): string | undefined {
  return PATH_LINE.exec(line)?.[1];
}

/**
 * The prefix of the fold notice. **Producing and recognising it must share this one
 * constant** — the two places once held their own literals, and when the wording changed
 * the recogniser did not follow, leaving fold lines to be kept as ordinary nodes.
 */
const COLLAPSED_MARK = "Collapsed ";

/**
 * Collapse the task tree around the current path.
 *
 * The fallback direction is **keep**, not delete: a line whose path will not parse is kept
 * as is, and an empty currentPath returns the tree untouched. Deleting wrongly destroys the
 * task state; keeping wrongly costs a few tokens. That asymmetry is what decides which way
 * the fallback leans.
 */
export function compactTaskTree(tree: string, currentPath: string): string {
  const cur = (currentPath ?? "").trim().split(".").filter(Boolean);
  if (!tree || cur.length === 0) {
    return tree;
  }

  const lines = tree.split("\n");
  const kept: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    const path = parseTaskPath(line);
    if (path === undefined) {
      kept.push(line); // unparsable -> keep it (when unsure, keep)
      continue;
    }
    const segs = path.split(".");
    // Level 1 is always kept; deeper levels only on the branch whose parent path shares the
    // current path's prefix.
    const keep =
      segs.length <= 1 ||
      segs.slice(0, -1).join(".") === cur.slice(0, segs.length - 1).join(".");
    if (keep) {
      kept.push(line);
    } else {
      dropped += 1;
    }
  }

  if (dropped === 0) {
    return tree;
  }
  // Tell the model plainly that the detail was folded rather than lost — otherwise it
  // expands the old detail all over again.
  kept.push(
    `(${COLLAPSED_MARK}${dropped} detail node(s) from branches already left behind, keeping only the trunk. Those steps are done: do not expand them again and do not redo them)`,
  );
  return kept.join("\n");
}
