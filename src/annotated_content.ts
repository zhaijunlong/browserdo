// Render the kernel's annotatedContent (a JSON tree) into the flat text the model reads.
//
// Why here and not in the browser: the JSON is the contract, the flat text is a rendering for
// one consumer. Rendering belongs to the consumer, or our diagnostic tools lose the structured
// form and every format tweak waits on a browser release.
//
// Why at all: measured over 1711 snapshots it saves 88% (a flight list page goes from 10239 to
// 995 tokens), and reasoning grows superlinearly with the prompt, so the cut pays twice.
//
// Format (bracketed parts appear only when present):
//     <emsn> <TAG>[:type] [name] "text" ="value" formats ... hint "grey text" checked/unchecked disabled readonly/aria-readonly
//     \t<emsn> <TAG>...        one Tab = inside the element on the line above
//     · [name] "text"          no number: read-only
//     <emsn> DIV scrollable: 537px more below   a pane that scrolls on its own
//     ... offscreen / partly offscreen         long snapshot only: not (fully) in the image
//     · "text in a closed DETAILS" collapsed   not on screen until the DETAILS is opened
//     <emsn> SELECT ="now" options "a" "b"     a closed dropdown's choices, for browserInputText
//     ... modal / hover-only / also dblclick, drag / not loaded yet   marks from the kernel (F0)
//
// Page text is quoted and numbers are not. A calendar is the worst case — `112 SPAN "16"` is
// number 112 showing date 16 — and both are one- or two-digit integers, so without the quotes a
// model looking for "16" grabs the wrong line. The number stays a bare integer because it goes
// into params.emsn verbatim.
//
// Indentation is Tab, not spaces: a line already separates its fields with spaces, and one
// character must not do both jobs.

/** One text run of an entry (pdl: "A text run"). */
interface RawTextRun {
  text?: unknown;
  /** [x, y, width, height] in DIP, with the viewport's top-left as the origin. */
  bbox?: unknown;
  repeat_group?: unknown;
  /**
   * `"cut"` the page's style cut it short, `"off_window"` it runs past the window; both carry
   * full_text. `"unseen"`: what a closed DETAILS holds, no bbox.
   */
  visibility?: unknown;
  /**
   * This run's words with the hidden ones beside it: the last run takes what is hidden after, the
   * first what is hidden before.
   */
  full_text?: unknown;
  /** Text the browser wrote itself: `css_content` (::before/::after). */
  generated?: unknown;
}

/**
 * One entry of annotatedContent (pdl: "An element"). Its fields sit beside `children`. The kinds
 * of entry are told apart in this order:
 *
 *   has `node_name`          -> a page element
 *   no, but has `bbox`       -> a region (a grouping saying "these belong together")
 *   neither                  -> plain wrapping
 *
 * WARNING **the test must read `node_name`, not "are there any fields"**: a region does have
 * fields (it carries `bbox`), so testing for field presence treats regions as elements and
 * emits a bare line for every region.
 *
 * WARNING **`emsn` only ever sits on an entry**, never on a text run (the pdl gives runs none), so
 * `text_runs[].emsn` is not read here. If the kernel ever numbered text runs, the symptom would
 * be those targets becoming unclickable inside text — a shape that once accounted for 39%.
 */
export interface RawNode {
  /** [x, y, width, height]. See readingOrder — arrival order is document order, so we must still sort ourselves. */
  bbox?: unknown;
  emsn?: unknown;
  /** The DOM nodeName: an upper-case tag name, or `#text`. Without this field it is not a page element. */
  node_name?: unknown;
  /** The accessible name. When present it says something the entry's own text does not. */
  label?: unknown;
  /** INPUT only: `text` / `password` / `radio` / `checkbox` and so on. */
  type?: unknown;
  /** Present on every element that has a checked state. **No key = this element has no checked state**, not "unchecked". */
  checked?: unknown;
  /** Only ever true. */
  disabled?: unknown;
  /** true: a read-only field, typing is refused and a click often opens the page's own picker. "declared": only aria-readonly says so, typing still goes in. */
  readonly?: unknown;
  /**
   * What the control is currently showing. Control entries have no text_runs; the text in the box
   * lives only here. In the focused one it carries the kernel's caret mark ‸ and selection marks
   * ⟦ ⟧, with ¤ before the page's own such characters; it is passed on as it is.
   */
  value?: unknown;
  /** The grey hint of an empty field: its value is "" or the caret mark alone. */
  placeholder?: unknown;
  /** On an editable area: its styled parts, `{text | from+to, style[], occurrence?, href?}`. */
  formats?: unknown;
  repeat_group?: unknown;
  /**
   * Present only on an entry that scrolls: content size and current offset, in the
   * same units as bbox. A scroller always carries an emsn, even when it is not clickable —
   * the kernel issues numbers to scrollers for exactly this.
   */
  scroll_width?: unknown;
  scroll_height?: unknown;
  scroll_x?: unknown;
  scroll_y?: unknown;
  /**
   * Long snapshot only: `"no"` = not visible, `"partial"` = partly visible. Absent =
   * fully visible. It also covers being clipped by a pane's window, which comparing the bbox
   * with the viewport cannot tell.
   */
  shown?: unknown;
  /**
   * With returnHref: the absolute address of the link this entry is in. Written once
   * per link: an entry without one inside a link inherits its nearest ancestor's.
   */
  href?: unknown;
  /**
   * F0: true on a modal dialog. Opened by showModal(), the page outside it has no emsn until it
   * closes; it is also set where the page only says so (aria-modal, an alertdialog).
   */
  modal?: unknown;
  /** F0, on a closed SELECT: every option's text, in order. */
  options?: unknown;
  /** F0: `"declared"`, `"listener"` or `"hover"` (maybe not clickable); absent = sure. */
  certainty?: unknown;
  /**
   * F0 (b492e02e66): what else it answers, each mapped to the emsn whose listener handles it (its
   * own, an enclosing one, or null when that one has no emsn). "click" appears only when an
   * enclosing element handles it.
   */
  actions?: unknown;
  /** F0, on an IFRAME: its content did not come back. */
  unread?: unknown;
  text_runs?: RawTextRun[];
  children?: RawNode[];
}

function hrefOf(n: RawNode): string | undefined {
  return typeof n?.href === "string" && n.href ? n.href : undefined;
}

/** One link of `current_scroll_chain`: what a scroll from the pointer's spot moves, innermost first. */
interface RawChainLink {
  emsn?: unknown;
  /** `"page"` on the document itself — identify it by this, not by emsn. */
  node_name?: unknown;
  up?: unknown;
  down?: unknown;
  left?: unknown;
  right?: unknown;
}

/** The top level of annotatedContent: the tree root plus the page-wide fields. */
interface RawRoot extends RawNode {
  page?: { width?: unknown; height?: unknown };
  viewport?: { width?: unknown; height?: unknown; scroll_x?: unknown; scroll_y?: unknown };
  /** What was read, in viewport coordinates: the screen, or a long snapshot's region cut to what is there. */
  content_bbox?: unknown;
  current_scroll_chain?: RawChainLink[];
}

/**
 * Indentation cap.
 *
 * "Depth" here is **how many ancestors carry an emsn**, not DOM depth. Measured, it reaches 2
 * at most; the cap of 3 leaves one level of room, so nesting clickable elements one deeper
 * does not let the indentation grow without bound.
 */
const MAX_INDENT = 3;

/**
 * A node's children. **Arrays only, and objects only.**
 *
 * This tree comes out of JSON.parse and its shape is not ours to guarantee. If `children` is
 * some other type, or the array holds a null, iterating straight over it is a TypeError — and
 * this renderer's whole stance is that sending the model something verbose beats letting one
 * malformed spot blind the entire round.
 */
function childrenOf(node: RawNode): RawNode[] {
  return Array.isArray(node?.children)
    ? node.children.filter((c): c is RawNode => !!c && typeof c === "object")
    : [];
}

/** One bbox: DIP, viewport origin, the same coordinate system as the annotated image. */
export type Box = { x: number; y: number; w: number; h: number };

/** Take [x, y, w, h] out of a bbox; undefined when the shape is wrong. */
function readBbox(v: unknown): Box | undefined {
  if (!Array.isArray(v) || v.length < 4) return undefined;
  const [x, y, w, h] = v.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  return { x, y, w, h };
}

/**
 * A node's **effective position**: its own bbox, or the union of its descendants' when it has
 * none.
 *
 * Pure container nodes carry no bbox — 431 of 2848 child nodes in one run — and readingOrder
 * abandons a whole batch the moment one position is missing, which left 147 of 413 sibling
 * sequences (36%) unsorted. Containers are the only nodes missing a bbox. With the union in
 * place that dropped to 0 of 146.
 *
 * **Do not trust a node's own box when it cannot hold its descendants.** Since September 2026 regions
 * (bbox, no node_name) also carry a bbox, but measurably on a DPR=2 screen regions use device
 * pixels while elements use CSS pixels — only 5-8% of 873 region boxes could contain their own
 * descendants, median width ratio 2.07. A quarter of sibling groups mix the two, so sorting each
 * by its own box puts those groups in the wrong order.
 *
 * The test is whether the descendant union's centre falls inside the node's own box. This is a
 * general self-consistency check, not a DPR patch: once the kernel fixes the units it starts
 * trusting the box again with no change here.
 */
function effectiveBox(node: RawNode, cache: Map<RawNode, unknown>): unknown {
  if (cache.has(node)) return cache.get(node);
  let union: Box | undefined;
  for (const child of childrenOf(node)) {
    const cb = readBbox(effectiveBox(child, cache));
    if (!cb) continue;
    union = union
      ? {
          x: Math.min(union.x, cb.x),
          y: Math.min(union.y, cb.y),
          w: Math.max(union.x + union.w, cb.x + cb.w) - Math.min(union.x, cb.x),
          h: Math.max(union.y + union.h, cb.y + cb.h) - Math.min(union.y, cb.y),
        }
      : cb;
  }
  const own = readBbox(node.bbox);
  const trustOwn =
    own &&
    (!union ||
      (union.x + union.w / 2 >= own.x &&
        union.x + union.w / 2 <= own.x + own.w &&
        union.y + union.h / 2 >= own.y &&
        union.y + union.h / 2 <= own.y + own.h));
  const box = trustOwn ? own : (union ?? own);
  const out = box ? [box.x, box.y, box.w, box.h] : undefined;
  cache.set(node, out);
  return out;
}

/**
 * A node's effective position, parsed into `{x,y,w,h}`.
 *
 * Exported for diagnostic code (the measurement scripts, the corpus regression): they measure "the
 * lines the model sees", so they must use the renderer's position rule. Four separate copies of
 * this once existed and three had dropped the self-consistency check above, which let the
 * measurements drift away from production.
 */
export function effectiveBoxOf(
  node: RawNode,
  cache: Map<RawNode, unknown>,
): Box | undefined {
  return readBbox(effectiveBox(node, cache));
}

/** A node's children in reading order. Shared by both traversals, so neither can miss one. */
function kids(node: RawNode, cache: Map<RawNode, unknown>): RawNode[] {
  return readingOrder(childrenOf(node), (c) => effectiveBox(c, cache));
}

/**
 * Reorder siblings into the order a person reads them.
 *
 * **Why we sort at all** (rewritten 2026-09-10, when the kernel started issuing emsn in document order): arrival order is document
 * order, and document order is not reading order. In `reading_order_probe.html` four cells are
 * `A B C D` in the document and `C D A B` on screen; this function gives `C D A B`. On real
 * sites arrival order measures about 2% wrongly split and 6-16% wrongly merged; this function
 * measures 0/0 on the same yardstick.
 *
 * WARNING **superseded conclusion, kept so nobody raises it again**: before 2026-09-10 arrival
 * order was hash order, measured at 46.6% / 50.0% — a coin flip. That is fixed, but "we sort
 * ourselves" still holds; only the reason changed.
 *
 * **Known wrong**: RTL and vertical writing (`dom_order_probe.html` sections 1-2), where arrival
 * order is right and geometry is not. A bbox carries no writing direction, so fixing it needs a
 * kernel field. Near-zero rate on target sites, so noted rather than fixed.
 *
 * Rows are grouped by y first, then sorted by x within a row: same-row elements differ by a few
 * pixels in y, and sorting by (y, x) directly interleaves them.
 *
 * **Degrading**: any item without a bbox returns the input unchanged, which since 2026-09-10 means
 * document order — a meaningful fallback.
 */
function readingOrder<T>(items: readonly T[], boxOf: (t: T) => unknown): T[] {
  if (items.length < 2) return [...items];
  const withBox = items.map((it) => ({ it, box: readBbox(boxOf(it)) }));
  if (withBox.some((x) => !x.box)) return [...items];

  const byY = [...withBox].sort((a, b) => a.box!.y - b.box!.y);
  const rows: (typeof byY)[] = [];
  for (const cur of byY) {
    const row = rows.at(-1);
    if (row && row.some((r) => sameLine(cur.box!, r.box!))) row.push(cur);
    else rows.push([cur]);
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => a.box!.x - b.box!.x).map((x) => x.it),
  );
}

/**
 * Whether two boxes are on the same visual row: **centre lines** within 60% of the shorter
 * one's height, and heights within a factor of 2 — or of 3 when the shorter lies within the
 * taller's height, as a superscript or a small currency sign does beside large digits (Lowe's
 * prices: "$" 18px, "107" 38px, ".24" 18px were read as "107" then "$ .24").
 *
 * Three rules measured on 15 corpus snapshots (split = same row ordered x-decreasing; merged =
 * different rows ordered y-decreasing):
 *
 *   top edge + median-height/2 tolerance   split 33/1435   merged  0/471
 *   vertical overlap with the row          split  0/1153   merged 68/613
 *   this rule                              split  4/1427   merged  1/449
 *
 * The 3x allowance measured the same as 2x on 1157 snapshots.
 *
 * Not the top edge, because membership would depend on which element starts the row: two
 * header elements both centred at 36 were split because the row happened to start at y=22.
 *
 * Not vertical overlap, because a 703px full-width container overlaps every 42px row item in
 * its column and swallows the whole column into one row — the 68 merges above.
 */
export function sameLine(a: Box, b: Box): boolean {
  const gap = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
  const [s, t] = a.h <= b.h ? [a, b] : [b, a];
  if (gap > s.h * 0.6) return false;
  if (t.h <= s.h * 2) return true;
  // Beside it, not under it: a wrapped two-line run is as tall and spans both lines' pieces.
  const xGap = Math.max(s.x - (t.x + t.w), t.x - (s.x + s.w));
  return t.h <= s.h * 3 && s.y >= t.y && s.y + s.h <= t.y + t.h && xGap <= s.h && -xGap < s.w / 2;
}

/** A piece of text, with whether white space trimmed off its ends was there. */
type Piece = { text: string; box?: Box; lead?: boolean; trail?: boolean };

function pieceOf(t: RawTextRun): Piece {
  const raw = String(rawTextOf(t) ?? "");
  return { text: textOf(t), box: readBbox(t?.bbox), lead: /^\s/.test(raw), trail: /\s$/.test(raw) };
}

/** A node's own text runs, in reading order, joined. */
function joinRuns(runs: readonly RawTextRun[]): string {
  return joinPieces(readingOrder(runs, (t) => t.bbox).map(pieceOf));
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * One node's runs as painted, unseen ones left out. A run's full_text stands for that run only
 * (hidden words before go on the first run, after on the last), so the runs in order give the
 * text once.
 */
function shownRuns(runs: readonly RawTextRun[] | undefined): RawTextRun[] {
  return (Array.isArray(runs) ? runs : []).filter(
    (t) => !!t && typeof t === "object" && t.visibility !== "unseen",
  );
}

/** The text of a node's unseen runs (inside a closed DETAILS), joined; "" when none. */
function unseenText(n: RawNode): string {
  const runs = Array.isArray(n.text_runs) ? n.text_runs : [];
  return runs
    .filter((t) => t?.visibility === "unseen")
    .map(textOf)
    .filter(Boolean)
    .join(" ");
}

/**
 * Join pieces already in reading order.
 *
 * Pieces touching on one line join with no space, so a word with a span per character (and CJK)
 * does not read "T h i s"; white space the page had between them is kept. A piece painted again
 * over a kept one is dropped; the same text elsewhere is content ("hello" has two l's).
 */
function joinPieces(pieces: readonly Piece[]): string {
  const kept: Piece[] = [];
  let out = "";
  for (const p of pieces) {
    if (!p.text) continue;
    if (kept.some((k) => k.text === p.text && (!k.box || !p.box || overlapShare(k.box, p.box) > 0.5))) continue;
    const prev = kept.at(-1);
    const joins = prev && !prev.trail && !p.lead && prev.box && p.box && touching(prev.box, p.box);
    out += prev && !joins ? ` ${p.text}` : p.text;
    kept.push(p);
  }
  return out;
}

/** On one line with a gap under 12% of its height; a space between words is about 20%. */
function touching(a: Box, b: Box): boolean {
  if (!sameLine(a, b)) return false;
  const gap = b.x - (a.x + a.w);
  return gap > -0.5 * Math.min(a.h, b.h) && gap < 0.12 * Math.min(a.h, b.h);
}

/** How much of the smaller box the two share. */
function overlapShare(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/**
 * Whether an emsn value is usable. **Digits only** — the pdl declares an integer emsn and all
 * 48402 in the corpus are plain digits.
 *
 * Tightening to digits closes a loophole by construction: collectEmsn scrapes the line start
 * with `/^\t*(\d+) /`, so an "a3" would render as `a3 SPAN "x"` — visible to the model, used by
 * it, never collected, and then refused by the executor. Visible but unusable is the hardest
 * failure to diagnose.
 */
function usable(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? s : undefined;
}

/**
 * The content of a text run. **When cut, give the full text**: the model wants the whole hotel
 * name or title rather than the painted fragment (which may also break mid-word).
 */
function textOf(t: RawTextRun): string {
  return squash(String(rawTextOf(t) ?? ""));
}

function rawTextOf(t: RawTextRun): unknown {
  return t?.full_text !== undefined ? t.full_text : t?.text;
}

/**
 * Every usable emsn in one annotatedContent.
 *
 * **Deliberately reuses the renderer**, so "the numbers shown to the model" and "the numbers
 * we allow acting on" are always the same set. Separate implementations drift sooner or later
 * — the old bug was exactly that: the renderer missed one place that carried a number while
 * this gate did not.
 */
export function collectEmsn(raw: unknown): Set<string> {
  return new Set(collectEmsnLines(raw).keys());
}

/**
 * Every usable number in one annotatedContent, mapped to its line in the rendered output.
 *
 * The whole line is kept so that **a failure can offer a way out**: when a number is not in
 * the list, the executor hands the model the nearest usable numbers along with their text. In
 * the observed failure the model wanted "Air China" (105) and gave 104, and 104 was a hole in
 * the numbering (the kernel issued 223 numbers across 0-265, with 42 holes). Told only to
 * "pick another" it gave the same 104 twice and then gave up; put `105 SPAN "Air China"` in
 * front of it and it will not.
 */
export function collectEmsnLines(raw: unknown): Map<string, string> {
  // On a parse failure return the empty set, **opening the gate rather than locking it**.
  //
  // The renderer returns the content unchanged when parsing fails (deliberately: verbose JSON
  // to the model beats a blank). But scraping raw JSON with a regex is dangerous — if some
  // line happened to start with "123 " the result would be a single-element set, and **every
  // real number would then be refused by the executor**. An empty set makes that gate skip
  // itself (it checks allowed.size), so the broken round can at least still move.
  if (!parseTree(raw)) return new Map();

  const out = new Map<string, string>();
  for (const line of renderAnnotatedContent(raw).split("\n")) {
    const m = /^\t*(\d+) /.exec(line);
    if (m && !out.has(m[1])) out.set(m[1], line.replace(/^\t+/, ""));
  }
  return out;
}

/** Parse into a tree; undefined when it will not parse. The renderer and collectEmsn share this one test. */
function parseTree(raw: unknown): RawNode | undefined {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw && typeof raw === "object") return raw as RawNode;
  return undefined;
}

/** Whether this entry is a control: it has a value, a hint or a checked state, or is an INPUT, SELECT or TEXTAREA. */
function isControl(n: RawNode): boolean {
  return (
    n.value !== undefined ||
    n.placeholder !== undefined ||
    n.checked !== undefined ||
    /^(INPUT|SELECT|TEXTAREA)$/.test(String(n.node_name ?? ""))
  );
}

/**
 * Everything after the emsn and the tag: `[name] "text" ="value" hint"grey" checked disabled`
 *
 * - `value` uses `=`, keeping it apart from the element's own text. Control
 *   entries have no text_runs, so a filled-in input renders as a bare line without it.
 * - `placeholder` is marked as a hint and must not look like `value`: acting on grey text as
 *   though it were entered content is unrecoverable.
 * - `checked` is emitted only when the key exists. Absent means "has no checked state".
 */
function describe(n: RawNode, text: string, reading = false): string {
  const parts: string[] = [];
  if (n.label !== undefined && String(n.label).trim()) {
    parts.push(`[${String(n.label)}]`);
  }
  if (text) parts.push(`"${text}"`);
  // JSON-quoted: an editable area's line breaks would split the line, and
  // browser_input_text's place parameters take them as \n.
  if (n.value !== undefined && String(n.value)) parts.push(`=${JSON.stringify(String(n.value))}`);
  // An empty editable area (a new mail body) has nothing else to say it takes typing; an
  // empty field's tag already does.
  else if (n.value === "" && !/^(INPUT|SELECT|TEXTAREA)$/.test(String(n.node_name ?? ""))) parts.push('=""');
  if (!reading) {
    const formats = describeFormats(n.formats);
    if (formats) parts.push(`formats ${formats}`);
  }
  if (n.placeholder !== undefined && String(n.placeholder).trim()) {
    parts.push(`hint "${String(n.placeholder)}"`);
  }
  if (n.checked !== undefined) parts.push(n.checked ? "checked" : "unchecked");
  if (n.disabled) parts.push("disabled");
  if (!reading && n.readonly === true) parts.push("readonly");
  else if (!reading && n.readonly === "declared") parts.push("aria-readonly");
  if (!reading) parts.push(...actingMarks(n));
  if (!reading && n.shown === "no") parts.push("offscreen");
  else if (!reading && n.shown === "partial") parts.push("partly offscreen");
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/** Options listed on one SELECT line; the kernel's refusal lists them all when one is missed. */
const MAX_OPTIONS = 30;

/** The kernel's F0 marks that matter for acting on a page and not for reading it; the ones about acting on it only with an emsn. */
function actingMarks(n: RawNode): string[] {
  const out: string[] = [];
  if (n.modal === true) out.push("modal");
  if (n.unread === true) out.push("not loaded yet");
  if (!usable(n.emsn)) return out;
  if (Array.isArray(n.options) && n.options.length) {
    const shown = n.options.slice(0, MAX_OPTIONS).map((o) => `"${squash(String(o))}"`);
    const more = n.options.length - shown.length;
    out.push(`options ${shown.join(" ")}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (n.certainty === "hover") out.push("hover-only");
  const also = alsoActions(n.actions);
  if (also.length) out.push(`also ${also.join(", ")}`);
  return out;
}

/**
 * The actions besides a plain click, every one the kernel lists (it sets no threshold on purpose,
 * b492e02e66). Who handles each is left out: acting on this number is what the model does either way.
 */
function alsoActions(actions: unknown): string[] {
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) return [];
  return Object.keys(actions).filter((a) => a !== "click");
}

/**
 * An editable area's styled parts: `bold+italic "this", link "website" https://…,
 * quote from "…" to "…", bold "good" #2`. The kernel gives a part over 60 characters as from/to;
 * #n is browser_input_text's occurrence of those words.
 */
function describeFormats(formats: unknown): string {
  if (!Array.isArray(formats)) return "";
  return formats
    .filter((f) => f && typeof f === "object")
    .map((f) => {
      const style = Array.isArray(f.style) ? f.style.join("+") : "";
      const words =
        typeof f.text === "string"
          ? JSON.stringify(f.text)
          : `from ${JSON.stringify(String(f.from ?? ""))} to ${JSON.stringify(String(f.to ?? ""))}`;
      const n = num(f.occurrence);
      const href = typeof f.href === "string" && f.href ? ` ${f.href}` : "";
      return `${style} ${words}${n !== undefined ? ` #${n}` : ""}${href}`.trim();
    })
    .join(", ");
}

/** A finite number, or undefined. */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether this entry scrolls on its own. */
function isScroller(n: RawNode): boolean {
  return n.scroll_width !== undefined || n.scroll_height !== undefined;
}

type Room = { up: number; down: number; left: number; right: number };

const ROOM_WORDS = [
  ["down", "below"],
  ["up", "above"],
  ["right", "to the right"],
  ["left", "to the left"],
] as const;

/** "537px more below, 120px above" — only the directions with room left; "" when none has. */
function describeRoom(r: Room): string {
  return ROOM_WORDS.filter(([k]) => Math.round(r[k]) > 0)
    .map(([k, word], i) => `${Math.round(r[k])}px ${i === 0 ? "more " : ""}${word}`)
    .join(", ");
}

function readRoom(l: RawChainLink): Room {
  return {
    up: num(l.up) ?? 0,
    down: num(l.down) ?? 0,
    left: num(l.left) ?? 0,
    right: num(l.right) ?? 0,
  };
}

function chainOf(root: RawRoot): RawChainLink[] {
  return Array.isArray(root.current_scroll_chain)
    ? root.current_scroll_chain.filter((l) => !!l && typeof l === "object")
    : [];
}

/** The chain's element links by emsn (the page link is left out). */
function chainRooms(root: RawRoot): Map<string, Room> {
  const out = new Map<string, Room>();
  for (const l of chainOf(root)) {
    const e = usable(l.emsn);
    if (e && l.node_name !== "page") out.set(e, readRoom(l));
  }
  return out;
}

/**
 * How much a scroller has left in each direction.
 *
 * The chain's figures are the kernel's own and exact, so a scroller on the chain uses them.
 * Off the chain it is worked out from the entry: content size minus offset minus the box. The
 * box includes borders and a scrollbar, so this undercounts by a few pixels (measured 3px on a
 * bordered pane) — close enough to say "there is more", which is all the model needs.
 */
function roomOf(n: RawNode, chain: ReadonlyMap<string, Room>): Room | undefined {
  const e = usable(n.emsn);
  const exact = e ? chain.get(e) : undefined;
  if (exact) return exact;
  const box = readBbox(n.bbox);
  if (!box) return undefined;
  const sx = num(n.scroll_x) ?? 0;
  const sy = num(n.scroll_y) ?? 0;
  const sw = num(n.scroll_width) ?? box.w;
  const sh = num(n.scroll_height) ?? box.h;
  return {
    up: Math.max(0, sy),
    down: Math.max(0, sh - sy - box.h),
    left: Math.max(0, sx),
    right: Math.max(0, sw - sx - box.w),
  };
}

/**
 * One paragraph on where this screen sits in the page and what a scroll would move, from the
 * scroll position fields. "" when the snapshot has none of them (an older kernel).
 *
 * Kept apart from renderAnnotatedContent on purpose: that output doubles as the "is this
 * snapshot empty" test and as the source of the usable-number list, and a header line would
 * make an empty tree look non-empty.
 *
 * **The document's size alone misleads on app-style pages** (mail, dashboards, chat): the
 * document does not scroll, so its height equals the screen and it reads "nothing more" while
 * a pane holds thousands of pixels. So that case is said outright, the chain is spelled out
 * whenever a scroll would move something other than the page, and panes are marked on their
 * own lines by renderAnnotatedContent.
 */
export function renderPagePosition(raw: unknown): string {
  const root = parseTree(raw) as RawRoot | undefined;
  if (!root) return "";
  const vh = num(root.viewport?.height);
  const ph = num(root.page?.height);
  const sy = num(root.viewport?.scroll_y) ?? 0;
  const out: string[] = [];

  if (vh && ph) {
    if (ph <= vh + 1) {
      out.push(
        "The page itself fits the screen and does not scroll; anything more is inside the panes marked scrollable below.",
      );
    } else {
      const screens = Math.ceil(ph / vh);
      // Counted by the bottom edge, so the last screen reads "N of N" even when it overlaps the one before.
      const at = Math.min(screens, Math.max(1, Math.ceil((sy + vh) / vh)));
      const below = Math.round(Math.max(0, ph - sy - vh));
      out.push(
        `The page is ${Math.round(ph)}px tall and this screen shows ${Math.round(sy)}-${Math.round(sy + vh)} of it ` +
          `(screen ${at} of ${screens}, one screen = ${Math.round(vh)}px)` +
          (below > 0 ? `; ${below}px more below.` : "; this is the bottom."),
      );
    }
  }

  // A long read. Said as a count of numbered elements off the image rather than as a range of
  // the page: on an app-style page the extra content is inside a pane, so a page range reads
  // "0-857" while 2000px more was read; and content_bbox is no guide either (Wikipedia measured
  // one starting 99837px above the top, from an element parked off-page).
  const read = readBbox(root.content_bbox);
  if (read && vh && (read.y < 0 || read.y + read.h > vh + 1)) {
    let off = 0;
    let total = 0;
    const count = (n: RawNode): void => {
      if (usable(n.emsn)) {
        total++;
        if (n.shown === "no" || n.shown === "partial") off++;
      }
      childrenOf(n).forEach(count);
    };
    count(root);
    out.push(
      `This round the element list is a long read, not just this screen: ${off} of its ${total} numbered elements are off the image, marked offscreen. ` +
        "The image still shows this screen only. Act on offscreen elements by emsn, which scrolls them in first.",
    );
  }

  const chain = chainOf(root);
  if (chain.length && chain[0].node_name !== "page") {
    const steps = chain.map((l) => {
      const room = describeRoom(readRoom(l)) || "at its end";
      return l.node_name === "page"
        ? `then the page (${room})`
        : `${usable(l.emsn) ?? "an unnumbered pane"} ${String(l.node_name ?? "")} (${room})`;
    });
    out.push(`A scroll without emsn now moves ${steps.join(", ")}.`);
    if (chain.some((l) => l.node_name === "page" && String(l.emsn) === "-1")) {
      out.push("To scroll the page itself instead, scroll with emsn -1.");
    }
  }
  return out.join(" ");
}

/**
 * Render annotatedContent. The input may be a JSON string or an already-parsed object.
 *
 * On a parse failure the input is **returned unchanged**: verbose JSON to the model beats a
 * blank — with no annotatedContent the round is blind.
 *
 * `numbers: false` is for reading only (browser_read_pages): no emsn, no "·" marking lines
 * without one, and none of the scroll room or offscreen notes that only matter for acting.
 *
 * `links: true` (needs returnHref) marks lines inside a link ` [^3]` and lists the addresses
 * after the text as `[^3]: https://...`.
 */
export function renderAnnotatedContent(
  raw: unknown,
  { numbers = true, links = false }: { numbers?: boolean; links?: boolean } = {},
): string {
  const { text, links: addresses } = renderWithLinks(raw, { numbers, links });
  return addresses.length === 0 ? text : `${text}\n\n${footnoteList(addresses, addresses.map((_, i) => i + 1))}`;
}

/** `[^n]: address` lines for these numbers; one with no address (page text reading "[^9]") is skipped. */
export function footnoteList(addresses: readonly string[], numbers: Iterable<number>): string {
  return [...numbers]
    .filter((n) => n >= 1 && n <= addresses.length)
    .map((n) => `[^${n}]: ${addresses[n - 1]}`)
    .join("\n");
}

/** The footnote numbers a piece of rendered text uses, in order. */
export function footnotesIn(text: string): number[] {
  return [...new Set([...text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])))];
}

/**
 * Render with links as footnotes: `links[n - 1]` is footnote n. Marks rather than inline
 * addresses keep a big menu from pushing the text back, give one address one number however
 * often it appears, and let a caller paging through list only its part's addresses. `[^n]`,
 * because page text often contains `[n]`.
 */
export function renderWithLinks(
  raw: unknown,
  { numbers = true, links = false }: { numbers?: boolean; links?: boolean } = {},
): { text: string; links: string[] } {
  const parsed = parseTree(raw);
  if (!parsed) return { text: typeof raw === "string" ? raw : "", links: [] };

  const lines: string[] = [];
  const addresses: string[] = [];
  const footnote = new Map<string, number>();
  const linkSuffix = (hs: string[]): string => {
    if (!links) return "";
    return hs
      .map((h) => {
        if (!footnote.has(h)) footnote.set(h, addresses.push(h));
        return ` [^${footnote.get(h)}]`;
      })
      .join("");
  };
  const chain = chainRooms(parsed as RawRoot);
  // A container's effective position has to be computed by walking its descendants; cache it so the same subtree is not unioned over and over.
  const boxCache = new Map<RawNode, unknown>();

  /**
   * insideEmsn: an ancestor above already carries an emsn and will absorb our unnumbered text
   * into its line. Without this flag the same text is emitted twice — once rolled up, once on
   * a line of its own.
   */
  const walk = (node: RawNode, depth: number, insideEmsn: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (node.node_name === undefined) {
      // The root, regions and plain wrappers all lack node_name, but their children still need
      // sorting — missing this leaves the top level of the whole tree in arrival order.
      //
      // **The test is node_name, not "are there any fields"**: a region carries a bbox, so
      // testing field presence treats it as an element. A well-formed region has only a bbox
      // and renders the same either way; but the moment it carries something like a label, an
      // entry appears out of nowhere.
      walkChildren(kids(node, boxCache), depth, insideEmsn);
      return;
    }

    const indent = (d: number) => "\t".repeat(Math.min(d, MAX_INDENT));
    // A control appends its type to the tag (INPUT:password): the only way the model can tell a
    // password box from an ordinary text box.
    const tag =
      String(node.node_name ?? "?") +
      (node.type !== undefined ? `:${String(node.type)}` : "");
    const nodeEmsn = usable(node.emsn);
    const textRuns = shownRuns(node.text_runs);

    // All text runs fold into this node's line. **Sort before joining**: a run's arrival order
    // is not its screen order, and joining in array order produces scrambled sentences (85
    // confirmed cases in the old corpus).
    const plainRuns = readingOrder(textRuns, (t) => t.bbox);

    let childDepth = depth;
    // A scroller keeps only its own text. Since late September 2026 every scroller is numbered, and folding
    // a whole pane's text into one line (an app's main pane holds nearly the entire page)
    // would bury the structure; its contents render as their own lines beneath it instead.
    const scroller = !!nodeEmsn && isScroller(node);
    if (nodeEmsn) {
      // Collect positions along with the runs and sort everything into reading order at the
      // end — text runs from different descendants need sorting too.
      const runs: RawTextRun[] = [...plainRuns];
      const own = hrefOf(node);
      const hrefs = new Set<string>(own ? [own] : []);
      // Fold in the text of every unnumbered descendant as well; a numbered descendant emits
      // its own line, so skip its whole subtree.
      const collect = (n: RawNode): void => {
        for (const child of childrenOf(n)) {
          if (usable(child.emsn)) continue; // it emits its own line; skip the whole subtree
          for (const t of shownRuns(child.text_runs)) {
            if (textOf(t)) runs.push(t);
          }
          const h = hrefOf(child);
          if (h) hrefs.add(h);
          collect(child);
        }
      };
      if (!scroller) collect(node);

      const joined = joinRuns(runs);
      let rest = describe(node, joined, !numbers);
      rest += linkSuffix([...hrefs]);
      const room = scroller && numbers ? roomOf(node, chain) : undefined;
      const left = room ? describeRoom(room) : "";
      if (left) rest += ` scrollable: ${left}`;
      if (numbers) {
        lines.push(`${indent(depth)}${nodeEmsn} ${tag}${rest}`);
      } else if (rest) {
        // For reading, a bare "svg" or "IMG" says nothing, and "#text" is not a tag a reader needs.
        lines.push(`${indent(depth)}${tag === "#text" ? rest.trimStart() : `${tag}${rest}`}`);
      }
      childDepth = depth + 1;
    } else {
      // No number of its own: emit whatever the ancestor's line could not absorb, read-only.
      //
      // Text only when there is no numbered ancestor — with one it has already been rolled up,
      // and emitting it again says it twice. Without this branch text is lost: 182 of 1195
      // snapshots once dropped top-level text that had no emsn ancestor to absorb it.
      //
      // Name, value, hint, checked and disabled go out either way: the roll-up only takes
      // text_runs. A `<label emsn=10><input placeholder="phone">` leaked exactly this way,
      // rendering as a bare `10 LABEL` with the input absent from the prompt.
      const s = insideEmsn
        ? ""
        : joinPieces(plainRuns.map(pieceOf));
      // With a numbered ancestor, that ancestor's line already carries this address.
      const own = insideEmsn ? undefined : hrefOf(node);
      const link = linkSuffix(own ? [own] : []);
      const rest = describe(node, s, !numbers) + link;
      // A dialog's or an unread frame's tag too: "· modal" or "· not loaded yet" alone says
      // nothing about what is meant.
      const control = isControl(node) || node.modal === true || node.unread === true ? ` ${tag}` : "";
      // Nothing but an offscreen mark (a table's empty cells) says nothing.
      if (rest && (describe(node, s, true) || link || (numbers && actingMarks(node).length))) {
        lines.push(`${indent(depth)}${numbers ? `·${control}${rest}` : `${control}${rest}`.trimStart()}`);
      }
    }

    // Children are walked in reading order: arrival order is document order, and a grid's
    // reading order is not its document order (the A B C D / C D A B case in readingOrder).
    walkChildren(kids(node, boxCache), childDepth, !scroller && (insideEmsn || !!nodeEmsn));

    // After the children, so a closed DETAILS reads its SUMMARY first.
    const hidden = unseenText(node);
    if (hidden) lines.push(`${indent(childDepth)}${numbers ? `· "${hidden}" collapsed` : hidden}`);
  };

  /** A node that is only text (no number, children, label or state): a word in a span. */
  const barePiece = (n: RawNode): Piece | undefined => {
    if (!n || typeof n !== "object" || n.node_name === undefined || usable(n.emsn)) return undefined;
    if (childrenOf(n).length > 0 || isControl(n) || n.disabled || (links && hrefOf(n))) return undefined;
    if (n.label !== undefined && String(n.label).trim()) return undefined;
    if (unseenText(n) || actingMarks(n).length) return undefined;
    const runs = readingOrder(shownRuns(n.text_runs), (t) => t.bbox);
    const text = joinPieces(runs.map(pieceOf));
    if (!text) return undefined;
    const box = effectiveBoxOf(n, boxCache);
    return { text, box, lead: pieceOf(runs[0]).lead, trail: pieceOf(runs[runs.length - 1]).trail };
  };

  /** Siblings in reading order; a run of bare text on one screen line is one line, not a word per line. */
  function walkChildren(children: RawNode[], depth: number, insideEmsn: boolean): void {
    for (let i = 0; i < children.length; ) {
      const group: Array<{ node: RawNode; piece: Piece & { box: Box } }> = [];
      for (let j = i; !insideEmsn && j < children.length; j++) {
        const piece = barePiece(children[j]);
        const prev = group.at(-1);
        if (!piece?.box || (prev && !sameLine(prev.piece.box, piece.box))) break;
        group.push({ node: children[j], piece: { ...piece, box: piece.box } });
      }
      if (group.length < 2) {
        walk(children[i], depth, insideEmsn);
        i++;
        continue;
      }
      const shown = group.map((g) => g.node.shown);
      const mark = !numbers
        ? ""
        : shown.every((v) => v === "no")
          ? " offscreen"
          : shown.some((v) => v === "no" || v === "partial")
            ? " partly offscreen"
            : "";
      const joined = joinPieces(group.map((g) => g.piece));
      lines.push(`${"\t".repeat(Math.min(depth, MAX_INDENT))}${numbers ? "· " : ""}"${joined}"${mark}`);
      i += group.length;
    }
  }

  walk(parsed, 0, false);
  return { text: lines.join("\n"), links: addresses };
}
