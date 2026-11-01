// Which parts of a page the model has seen, per scrolling area, across rounds.
//
// Why per area and not per page: on app-style pages (Ctrip's home page, web mail) the document
// does not scroll at all — the content the user reads is a pane that scrolls on its own. Counting
// the document's scroll position there says "seen 1 screen" however far the pane was read.
//
// Why a content check and not just "same place, same size": element numbers are reissued every
// snapshot, so an area can only be recognised by where it sits. A different area can sit in the
// same place (web mail: the inbox list and an opened mail fill the same pane, and the address
// often differs only after `#`, which page records strip), and a filtered list keeps its place and
// size while its content is replaced. Both would carry old coverage over to new content. So the
// text seen at each content position is kept, and where two rounds overlap the text has to agree.

import type { RawNode } from "./annotated_content.js";

/**
 * Areas smaller than this share of the viewport are not tracked. 10% keeps the main panes and
 * also side bars such as Wikipedia's contents (13%) and Ctrip's left navigation (11%); inputs
 * and small carousels (around 1%) stay out.
 */
const MIN_AREA_SHARE = 0.1;

/** Pixels an area may move or resize by between rounds and still count as the same place. */
const PLACE_TOLERANCE = 4;

/** Pixels a line of text may shift by in content coordinates and still count as the same spot. */
const SAMPLE_TOLERANCE = 3;

/** Fewer comparable lines than this and the check cannot decide; the area is taken on its place alone. */
const MIN_COMPARABLE = 5;

/**
 * Below this share of matching lines, the content counts as replaced. Not "any line differs":
 * ad rotators, countdowns and sticky headers inside a pane change a few lines on their own.
 */
const MIN_MATCH_SHARE = 0.5;

/** A content height this much smaller than before also means the content was replaced. */
const SHRINK_RESET = 0.8;

/** Cap on stored text samples per area, so a long read of a huge page cannot grow without bound. */
const MAX_SAMPLES = 4000;

type Range = [number, number];

/** One area as seen in one snapshot. */
export interface AreaObservation {
  kind: "page" | "pane";
  /** This round's number for the pane; numbers are reissued every round, so it is never used to match. */
  emsn?: string;
  nodeName: string;
  /** Where the area sits, in viewport and in page coordinates (a sticky pane keeps the first, an in-flow one the second). */
  box: { x: number; y: number; w: number; h: number };
  pageY: number;
  /** One screen of this area: the viewport height for the page, the box height for a pane. */
  windowH: number;
  contentH: number;
  seen: Range;
  /** Text by content position (rounded px). */
  samples: Map<number, string[]>;
}

/** One area's accumulated coverage on one page. */
export interface AreaCoverage {
  kind: "page" | "pane";
  emsn?: string;
  nodeName: string;
  box: { x: number; y: number; w: number; h: number };
  pageY: number;
  windowH: number;
  contentH: number;
  /** Seen ranges in content coordinates, sorted and merged. */
  ranges: Range[];
  samples: Map<number, string[]>;
  /** The content grew since first seen: more may still load at the bottom. */
  grew: boolean;
  /** The round its content was found replaced and the coverage started over, if it was. */
  resetRound?: number;
  lastRound: number;
}

/** What the prompt shows: an area's coverage without the samples. */
export interface CoverageSummary {
  kind: "page" | "pane";
  emsn?: string;
  nodeName: string;
  box: { x: number; y: number; w: number; h: number };
  windowH: number;
  contentH: number;
  ranges: Range[];
  grew: boolean;
  resetRound?: number;
  lastRound: number;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function box4(v: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!Array.isArray(v) || v.length < 4) return undefined;
  const [x, y, w, h] = v.map(Number);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : undefined;
}

function kidsOf(n: RawNode): RawNode[] {
  return Array.isArray(n?.children)
    ? n.children.filter((c): c is RawNode => !!c && typeof c === "object")
    : [];
}

function isScroller(n: RawNode): boolean {
  return n.scroll_width !== undefined || n.scroll_height !== undefined;
}

function clamp(r: Range, lo: number, hi: number): Range {
  return [Math.max(lo, r[0]), Math.min(hi, r[1])];
}

/**
 * Text runs belonging to one area, by content position: those not inside a nested scroller,
 * and not under an entry marked as not moving with it (`in_scroller`: fixed to the viewport or
 * the page). Unseen runs (a closed DETAILS) have no bbox and drop out.
 */
function collectSamples(
  under: RawNode[],
  toContentY: (viewportY: number) => number,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let count = 0;
  const walk = (n: RawNode): void => {
    if (count >= MAX_SAMPLES) return;
    if (isScroller(n) || (n as { in_scroller?: unknown }).in_scroller !== undefined) return;
    for (const t of Array.isArray(n.text_runs) ? n.text_runs : []) {
      const text = String(t?.full_text ?? t?.text ?? "").replace(/\s+/g, " ").trim();
      const b = box4(t?.bbox);
      if (!text || !b) continue;
      const y = Math.round(toContentY(b.y));
      const list = out.get(y) ?? [];
      list.push(text);
      out.set(y, list);
      count++;
    }
    kidsOf(n).forEach(walk);
  };
  under.forEach(walk);
  return out;
}

/**
 * The areas worth tracking in one snapshot: the document when it scrolls, and each pane that
 * scrolls vertically and covers at least MIN_AREA_SHARE of the viewport.
 */
export function observeAreas(raw: unknown): AreaObservation[] {
  let root: any;
  try {
    root = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!root || typeof root !== "object") return [];
  const vw = num(root.viewport?.width);
  const vh = num(root.viewport?.height);
  const ph = num(root.page?.height);
  if (!vw || !vh || !ph) return [];
  const sy = num(root.viewport?.scroll_y) ?? 0;
  const read = box4(root.content_bbox);
  const long = !!read && (read.y < 0 || read.y + read.h > vh + 1);
  const out: AreaObservation[] = [];

  if (ph > vh + 1) {
    // A long read reports what it read as content_bbox, which can reach far outside the page
    // (an element parked 99837px above the top on Wikipedia), so it is cut to the page.
    const seen: Range = long && read ? [read.y + sy, read.y + read.h + sy] : [sy, sy + vh];
    out.push({
      kind: "page",
      nodeName: "page",
      box: { x: 0, y: 0, w: vw, h: vh },
      pageY: 0,
      windowH: vh,
      contentH: ph,
      seen: clamp(seen, 0, ph),
      samples: collectSamples(kidsOf(root), (y) => y + sy),
    });
  }

  const walk = (n: RawNode): void => {
    if (isScroller(n)) {
      // The pane's own box, its window. Not the union of its children, which runs past the
      // window by exactly the content that is scrolled out of it.
      const b = box4(n.bbox);
      const sh = num(n.scroll_height);
      const top = num(n.scroll_y) ?? 0;
      if (b && sh && sh > b.h + 1 && (b.w * b.h) / (vw * vh) >= MIN_AREA_SHARE) {
        // A pane a long read did not read whole says which part it did (content
        // coordinates); one it did read whole leaves the field out.
        const part = box4((n as { snapshotted_bbox?: unknown }).snapshotted_bbox);
        const seen: Range = long ? (part ? [part.y, part.y + part.h] : [0, sh]) : [top, top + b.h];
        out.push({
          kind: "pane",
          emsn: n.emsn === undefined ? undefined : String(n.emsn),
          nodeName: String(n.node_name ?? ""),
          box: b,
          pageY: b.y + sy,
          windowH: b.h,
          contentH: sh,
          seen: clamp(seen, 0, sh),
          samples: collectSamples(kidsOf(n), (y) => y - b.y + top),
        });
      }
    }
    kidsOf(n).forEach(walk);
  };
  walk(root);
  return out;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= PLACE_TOLERANCE;
}

/** Same kind, same tag, same size, and the same place on screen or on the page. */
function samePlace(c: AreaCoverage, o: AreaObservation): boolean {
  if (c.kind !== o.kind) return false;
  if (o.kind === "page") return true;
  return (
    c.nodeName === o.nodeName &&
    near(c.box.x, o.box.x) &&
    near(c.box.w, o.box.w) &&
    near(c.box.h, o.box.h) &&
    (near(c.box.y, o.box.y) || near(c.pageY, o.pageY))
  );
}

/**
 * The same pane moved or resized: same tag, same left edge and width, same content height.
 * Only ever accepted together with agreeing text (see mergeCoverage) — a sticky side bar
 * changes its height and top as the page scrolls (Wikipedia's contents: 721 high at y=136, then
 * 809 at y=24), and place alone would count it twice.
 */
function sameShape(c: AreaCoverage, o: AreaObservation): boolean {
  return (
    c.kind === "pane" &&
    o.kind === "pane" &&
    c.nodeName === o.nodeName &&
    near(c.box.x, o.box.x) &&
    near(c.box.w, o.box.w) &&
    near(c.contentH, o.contentH)
  );
}

/**
 * Whether the text seen now agrees with the text seen before, where the two overlap.
 * undefined when too few lines overlap to say.
 */
function sameContent(c: AreaCoverage, o: AreaObservation): boolean | undefined {
  let comparable = 0;
  let matched = 0;
  for (const [y, texts] of o.samples) {
    const before: string[] = [];
    for (let d = -SAMPLE_TOLERANCE; d <= SAMPLE_TOLERANCE; d++) {
      before.push(...(c.samples.get(y + d) ?? []));
    }
    if (!before.length) continue;
    for (const t of texts) {
      comparable++;
      if (before.includes(t)) matched++;
    }
  }
  if (comparable < MIN_COMPARABLE) return undefined;
  return matched / comparable >= MIN_MATCH_SHARE;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function fresh(o: AreaObservation, round: number, resetRound?: number): AreaCoverage {
  return {
    kind: o.kind,
    emsn: o.emsn,
    nodeName: o.nodeName,
    box: o.box,
    pageY: o.pageY,
    windowH: o.windowH,
    contentH: o.contentH,
    ranges: mergeRanges([o.seen]),
    samples: new Map(o.samples),
    grew: false,
    resetRound,
    lastRound: round,
  };
}

/**
 * Fold one snapshot's areas into a page's coverage. An area in the same place whose text agrees
 * (or cannot be compared) extends its coverage; one whose text disagrees, or whose content shrank
 * sharply, starts over. Areas not seen this round are kept: a pane can be hidden for a round.
 */
export function mergeCoverage(
  prev: readonly AreaCoverage[],
  observed: readonly AreaObservation[],
  round: number,
): AreaCoverage[] {
  const out = [...prev];
  for (const o of observed) {
    let i = out.findIndex((c) => samePlace(c, o));
    if (i < 0) i = out.findIndex((c) => sameShape(c, o) && sameContent(c, o) === true);
    if (i < 0) {
      out.push(fresh(o, round));
      continue;
    }
    const c = out[i];
    const replaced = o.contentH < c.contentH * SHRINK_RESET || sameContent(c, o) === false;
    if (replaced) {
      out[i] = fresh(o, round, round);
      continue;
    }
    for (const [y, texts] of o.samples) {
      if (c.samples.size >= MAX_SAMPLES) break;
      c.samples.set(y, texts);
    }
    out[i] = {
      ...c,
      emsn: o.emsn,
      box: o.box,
      pageY: o.pageY,
      windowH: o.windowH,
      contentH: Math.max(c.contentH, o.contentH),
      grew: c.grew || o.contentH > c.contentH + 1,
      ranges: mergeRanges([...c.ranges, o.seen]),
      lastRound: round,
    };
  }
  return out;
}

export function summarize(areas: readonly AreaCoverage[]): CoverageSummary[] {
  return areas.map(({ samples: _samples, pageY: _pageY, ...rest }) => ({
    ...rest,
    ranges: rest.ranges.map((r) => [r[0], r[1]] as Range),
  }));
}

function seenPx(ranges: readonly Range[], contentH: number): number {
  return ranges.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, contentH) - a), 0);
}

/** The parts not yet seen, as ranges. */
function gaps(ranges: readonly Range[], contentH: number): Range[] {
  const out: Range[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at + 1) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (contentH > at + 1) out.push([at, contentH]);
  return out;
}

/**
 * One line per area, for the prompt:
 *   the page: seen 0-1714 of 10497px (about 2 of 13 screens); not seen 1714-10497
 *
 * `current`: the area is on the page being shown this round, so its number from this round's
 * list is given (numbers from older rounds are void and are left out).
 */
export function describeCoverage(
  areas: readonly CoverageSummary[],
  round: number,
  current: boolean,
): string[] {
  return areas.map((a) => {
    const r = (n: number) => Math.round(n);
    const name =
      a.kind === "page"
        ? "the page"
        : `${current && a.lastRound === round && a.emsn ? `pane ${a.emsn} ` : "the pane "}${a.nodeName} (${r(a.box.w)}x${r(a.box.h)} at ${r(a.box.x)},${r(a.box.y)})`;
    const seen = a.ranges.map(([s, e]) => `${r(s)}-${r(e)}`).join(", ") || "nothing";
    const screens = Math.max(1, Math.ceil(a.contentH / a.windowH));
    const seenScreens = Math.min(screens, Math.max(1, Math.round(seenPx(a.ranges, a.contentH) / a.windowH)));
    const missing = gaps(a.ranges, a.contentH);
    const rest = missing.length
      ? `not seen ${missing.slice(0, 3).map(([s, e]) => `${r(s)}-${r(e)}`).join(", ")}${missing.length > 3 ? " and more" : ""}`
      : "all of it seen";
    const notes = [
      a.grew ? "it has grown since you first saw it, so more may still load at the bottom" : "",
      a.resetRound !== undefined
        ? `its content was replaced in round ${a.resetRound}, so only what you saw since then counts`
        : "",
    ].filter(Boolean);
    return (
      `${name}: seen ${seen} of ${r(a.contentH)}px (about ${seenScreens} of ${screens} screens); ${rest}` +
      (notes.length ? ` (${notes.join("; ")})` : "")
    );
  });
}
