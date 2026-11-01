// Which parts of a page the model has seen, per scrolling area.
//
// The cases that matter most are the "is this still the same content" ones: an area can only be
// recognised by where it sits (numbers are reissued every round), so a filtered list or an opened
// mail in the same pane would otherwise inherit coverage it never earned — telling the model it
// has read content it has not seen at all.
import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCoverage,
  mergeCoverage,
  observeAreas,
  summarize,
} from "../../src/read_coverage.js";
import { BrowserRuntimeMemory } from "../../src/runtime_memory.js";

const VIEW = { width: 1000, height: 800, scroll_x: 0, scroll_y: 0 };

/** A snapshot with one 900x800 pane at (100,0) scrolled to `top`, showing rows of `rows(i)` 40px apart. */
function paneSnapshot(top: number, rows: (i: number) => string, extra: Record<string, unknown> = {}) {
  const children = [];
  for (let i = 0; i < 100; i++) {
    const y = i * 40 - top;
    if (y < 0 || y > 800) continue;
    children.push({ node_name: "P", text_runs: [{ text: rows(i), bbox: [110, y, 200, 20] }] });
  }
  return {
    viewport: VIEW,
    page: { width: 1000, height: 800 },
    content_bbox: [0, 0, 1000, 800],
    children: [
      {
        emsn: "3",
        node_name: "DIV",
        bbox: [100, 0, 900, 800],
        scroll_width: 900,
        scroll_height: 4000,
        scroll_x: 0,
        scroll_y: top,
        children,
        ...extra,
      },
    ],
  };
}

const inbox = (i: number) => `inbox mail ${i}`;

function fold(...snaps: unknown[]) {
  let areas = mergeCoverage([], [], 0);
  snaps.forEach((s, i) => {
    areas = mergeCoverage(areas, observeAreas(s), i + 1);
  });
  return areas;
}

test("an app-style page: the pane is tracked, the page that does not scroll is not", () => {
  const areas = observeAreas(paneSnapshot(0, inbox));
  assert.deepEqual(areas.map((a) => a.kind), ["pane"]);
  assert.deepEqual(areas[0].seen, [0, 800]);
});

test("scrolling the same pane extends what has been seen, and the gap is named", () => {
  const areas = fold(paneSnapshot(0, inbox), paneSnapshot(400, inbox), paneSnapshot(2000, inbox));
  assert.equal(areas.length, 1);
  assert.deepEqual(areas[0].ranges, [[0, 1200], [2000, 2800]]);
  const [line] = describeCoverage(summarize(areas), 3, true);
  assert.match(line, /pane 3 DIV/);
  assert.match(line, /seen 0-1200, 2000-2800 of 4000px \(about 3 of 5 screens\)/);
  assert.match(line, /not seen 1200-2000, 2800-4000/);
});

// The case the whole check exists for: same place, same size, the list swapped (a filter, an opened mail).
test("same place, different text where the two rounds overlap -> the coverage starts over", () => {
  const areas = fold(
    paneSnapshot(0, inbox),
    paneSnapshot(400, inbox),
    paneSnapshot(0, (i) => `opened mail paragraph ${i}`),
  );
  assert.equal(areas.length, 1);
  assert.deepEqual(areas[0].ranges, [[0, 800]], "what was seen of the old list must not count");
  assert.equal(areas[0].resetRound, 3);
  assert.match(describeCoverage(summarize(areas), 3, true)[0], /content was replaced in round 3/);
});

test("a few changed lines (an ad, a countdown) do not count as replaced content", () => {
  const areas = fold(
    paneSnapshot(0, inbox),
    paneSnapshot(0, (i) => (i === 2 || i === 5 ? `ad ${i}` : inbox(i))),
  );
  assert.equal(areas[0].resetRound, undefined);
});

test("no overlap to compare (a jump straight to the bottom) -> taken on its place alone", () => {
  const areas = fold(paneSnapshot(0, inbox), paneSnapshot(3200, inbox));
  assert.deepEqual(areas[0].ranges, [[0, 800], [3200, 4000]]);
  assert.equal(areas[0].resetRound, undefined);
});

test("content much shorter than before -> replaced, even where no text overlaps", () => {
  const short = paneSnapshot(0, (i) => `result ${i}`);
  (short.children[0] as Record<string, unknown>).scroll_height = 1500;
  const areas = fold(paneSnapshot(3200, inbox), short);
  assert.equal(areas[0].resetRound, 2);
});

test("content that grew (a list loading more at the bottom) is said to be still growing", () => {
  const longer = paneSnapshot(400, inbox);
  (longer.children[0] as Record<string, unknown>).scroll_height = 6000;
  const [line] = describeCoverage(summarize(fold(paneSnapshot(0, inbox), longer)), 2, true);
  assert.match(line, /of 6000px/);
  assert.match(line, /grown since you first saw it/);
});

// Wikipedia's contents bar: 721 high at y=136, then 809 at y=24 once the page scrolled.
test("a sticky pane that moved and resized, with the same text, is still one area", () => {
  const moved = paneSnapshot(0, inbox);
  const pane = moved.children[0] as Record<string, unknown>;
  pane.bbox = [100, 60, 900, 740];
  for (const c of pane.children as Array<{ text_runs: Array<{ bbox: number[] }> }>) {
    c.text_runs[0].bbox[1] += 60;
  }
  const areas = fold(paneSnapshot(0, inbox), moved);
  assert.equal(areas.length, 1);
});

test("a moved pane with different text is a different area, not a continuation", () => {
  const other = paneSnapshot(0, (i) => `settings item ${i}`);
  (other.children[0] as Record<string, unknown>).bbox = [100, 60, 900, 740];
  assert.equal(fold(paneSnapshot(0, inbox), other).length, 2);
});

test("panes under 10% of the screen are not tracked", () => {
  const snap = paneSnapshot(0, inbox);
  (snap.children[0] as Record<string, unknown>).bbox = [100, 0, 200, 300];
  assert.equal(observeAreas(snap).length, 0);
});

test("a long read counts the part of a pane it read, as the kernel reports it", () => {
  const partial = { ...paneSnapshot(0, inbox), content_bbox: [0, -8000, 1000, 16800] };
  (partial.children[0] as Record<string, unknown>).snapshotted_bbox = [0, 0, 900, 2500];
  assert.deepEqual(observeAreas(partial)[0].seen, [0, 2500]);

  const whole = { ...paneSnapshot(0, inbox), content_bbox: [0, -8000, 1000, 16800] };
  assert.deepEqual(observeAreas(whole)[0].seen, [0, 4000], "no snapshotted_bbox = read whole");
});

// Wikipedia measured a content_bbox starting 99837px above the top (an element parked off-page).
test("a long read of a scrolling page is cut to the page", () => {
  const snap = {
    viewport: VIEW,
    page: { width: 1000, height: 5000 },
    content_bbox: [0, -99837, 1000, 102000],
    children: [],
  };
  assert.deepEqual(observeAreas(snap)[0].seen, [0, 2163]);
});

test("the page record carries the coverage summary, and the text samples stay out of it", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, "https://mail.test/", "mail");
  m.recordPageCoverage(1, JSON.stringify(paneSnapshot(0, inbox)));
  const page = m.getSnapshot().pages[0];
  assert.equal(page.coverage?.length, 1);
  assert.ok(!("samples" in page.coverage![0]), "text samples stay out of the prompt state");
});

test("nothing to track: unparsable, empty, or without the page-wide fields", () => {
  assert.deepEqual(observeAreas("{not valid JSON"), []);
  assert.deepEqual(observeAreas({}), []);
  assert.deepEqual(observeAreas({ viewport: VIEW, children: [] }), [], "no page size");
  assert.deepEqual(describeCoverage([], 1, true), []);
});

test("a scrolling page: what this screen shows, in page coordinates", () => {
  const snap = {
    viewport: { ...VIEW, scroll_y: 1000 },
    page: { width: 1000, height: 5000 },
    content_bbox: [0, 0, 1000, 800],
    children: [{ node_name: "P", text_runs: [{ text: "row", bbox: [0, 40, 100, 20] }] }],
  };
  const [page] = observeAreas(snap);
  assert.deepEqual(page.seen, [1000, 1800]);
  assert.deepEqual([...page.samples], [[1040, ["row"]]]);
});

test("a pane's samples leave out a nested pane's text and what does not scroll with it", () => {
  const snap = paneSnapshot(0, inbox);
  const pane = snap.children[0] as { children: unknown[] };
  pane.children.push(
    { node_name: "HEADER", in_scroller: "viewport", text_runs: [{ text: "sticky", bbox: [110, 0, 200, 20] }] },
    {
      emsn: "7", node_name: "DIV", bbox: [110, 100, 400, 300], scroll_height: 900, scroll_y: 0,
      children: [{ node_name: "P", text_runs: [{ text: "inner", bbox: [120, 100, 100, 20] }] }],
    },
  );
  const areas = observeAreas(snap);
  assert.deepEqual(areas.map((a) => a.emsn), ["3", "7"], "the nested pane is an area of its own");
  const outer = [...areas[0].samples.values()].flat();
  assert.ok(!outer.includes("sticky") && !outer.includes("inner"), outer.join("|"));
  assert.deepEqual([...areas[1].samples.values()].flat(), ["inner"]);
});

test("the coverage line rounds fractions, and gives a pane's number only when it is from this round's list", () => {
  const area = {
    kind: "pane" as const, emsn: "3", nodeName: "DIV",
    box: { x: 100.4, y: 0.6, w: 899.5, h: 800.2 }, windowH: 800.2, contentH: 4000.4,
    ranges: [[0, 800.6]] as [number, number][], grew: false, lastRound: 1,
  };
  assert.equal(
    describeCoverage([area], 1, true)[0],
    "pane 3 DIV (900x800 at 100,1): seen 0-801 of 4000px (about 1 of 5 screens); not seen 801-4000",
  );
  assert.match(describeCoverage([area], 2, true)[0], /^the pane DIV /, "a number from an older round is void");
  assert.match(describeCoverage([area], 1, false)[0], /^the pane DIV /, "not the page being shown");
});

test("more than three gaps: the first three, then 'and more'; fully read: 'all of it seen'", () => {
  const base = { kind: "page" as const, nodeName: "page", box: { x: 0, y: 0, w: 1000, h: 800 }, windowH: 800, contentH: 8000, grew: false, lastRound: 1 };
  const holes = describeCoverage([{ ...base, ranges: [[0, 800], [1600, 2400], [3200, 4000], [4800, 5600]] }], 1, true)[0];
  assert.match(holes, /not seen 800-1600, 2400-3200, 4000-4800 and more$/);
  assert.match(describeCoverage([{ ...base, ranges: [[0, 8000]] }], 1, true)[0], /about 10 of 10 screens\); all of it seen$/);
});

// As in the renderer, a text_runs that is not an array counts as none.
test("a malformed text_runs does not throw", () => {
  const snap = { viewport: VIEW, page: { width: 1000, height: 5000 }, children: [{ node_name: "P", text_runs: {} }] };
  assert.doesNotThrow(() => observeAreas(snap));
});