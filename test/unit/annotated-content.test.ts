// The flat rendering of annotatedContent.
//
// Why: one Ctrip flight list page's annotatedContent is 32KB of JSON, about 10239 tokens, and GLM's
// reasoning grows superlinearly with the prompt (prompt 6.6k -> reasoning ~1500; prompt 18.4k ->
// reasoning 12749). So shrinking the prompt pays twice: less prefill and less thinking.
//
// **The most important cases in this group are the "no text is lost" ones.** The first renderer lost
// text (182 of 1195 snapshots were missing top-level text such as "Check-in and seats" or
// "Boeing 787 (large)"), and losing text is silent — what the model cannot see it treats as absent
// from the page, with no error anywhere.
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectEmsn,
  renderPagePosition,
  renderAnnotatedContent,
  footnoteList,
  sameLine,
} from "../../src/annotated_content.js";

// An entry's own fields sit beside children.
// Passing undefined as the first argument means "an entry with no node_name" (the root, a region, a plain wrapper).
const node = (
  fields: Record<string, unknown> | undefined,
  children: unknown[] = [],
) => ({ ...(fields ?? {}), children });
const text = (s: string) => ({ text: s });

test("one interactive element renders as one line: emsn TAG [name] text", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "12",
        node_name: "INPUT",
        label: "Enter departure city",
        text_runs: [text("Shenzhen")],
      }),
    ]),
  );
  assert.equal(out, '12 INPUT [Enter departure city] "Shenzhen"');
});

test("text with no emsn rolls up into the nearest emsn ancestor's line", () => {
  // A button wrapping a SPAN wrapping a text node is the commonest shape on a page.
  // Three lines fold into one, and the text is still there.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "4", node_name: "BUTTON", label: "Travel" }, [
        node({ node_name: "SPAN" }, [
          node({ node_name: "#text", text_runs: [text("Travel")] }),
        ]),
      ]),
    ]),
  );
  assert.equal(out, '4 BUTTON [Travel] "Travel"');
});

test("a descendant with an emsn emits its own line, with one Tab meaning 'inside the line above'", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "304", node_name: "INPUT", label: "City or airport" }, [
        node({ emsn: "303", node_name: "DIV", text_runs: [text("Shenzhen (SZX)")] }),
      ]),
    ]),
  );
  assert.equal(
    out,
    '304 INPUT [City or airport]\n\t303 DIV "Shenzhen (SZX)"',
  );
});

test("two inputs with the same name are told apart by the value line below each", () => {
  // Origin and destination on Ctrip's home page have the same name; without the line below each,
  // the model has to guess from the image.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "304", node_name: "INPUT", label: "City or airport" }, [
        node({ emsn: "303", node_name: "DIV", text_runs: [text("Shenzhen (SZX)")] }),
      ]),
      node({ emsn: "306", node_name: "INPUT", label: "City or airport" }, [
        node({ emsn: "305", node_name: "DIV", text_runs: [text("Beijing (BJS)")] }),
      ]),
    ]),
  );
  assert.match(out, /304 INPUT.*\n\t303 DIV "Shenzhen \(SZX\)"/);
  assert.match(out, /306 INPUT.*\n\t305 DIV "Beijing \(BJS\)"/);
});

test("indentation uses Tab rather than spaces — a line separates its fields with spaces, so the two cannot be the same character", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "DIV" }, [
        node({ emsn: "2", node_name: "SPAN", text_runs: [text("alpha")] }),
      ]),
    ]),
  );
  const child = out.split("\n")[1];
  assert.ok(child.startsWith("\t"), "a child line must start with a Tab");
  assert.ok(!child.startsWith(" "), "spaces must not be used for indentation");
});

// ---- no text lost: this group really has caught bugs ----

test("text with no emsn ancestor at all emits its own line starting with · (it must not be lost)", () => {
  // This is where the first version lost text: top-level text has no emsn ancestor to absorb it, and the roll-up simply missed it.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ node_name: "SPAN", text_runs: [text("Check-in and seats")] }),
      node({ emsn: "9", node_name: "BUTTON", label: "Search" }),
    ]),
  );
  assert.ok(out.includes('· "Check-in and seats"'), `top-level text was lost: ${JSON.stringify(out)}`);
  assert.ok(out.includes("9 BUTTON [Search]"));
});

test("one piece of text is never both rolled up and emitted on its own line", () => {
  // Emitting it again after the roll-up is charging twice. Half the read-only lines in the first version were duplicates like this.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "BUTTON" }, [
        node({ node_name: "#text", text_runs: [text("Search anything travel related")] }),
      ]),
    ]),
  );
  assert.equal(out, '1 BUTTON "Search anything travel related"');
  assert.equal(
    out.split("Search anything travel related").length - 1,
    1,
    "this text should appear exactly once",
  );
});

test("repeated text is deduplicated within one line", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "BUTTON" }, [
        node({ node_name: "SPAN", text_runs: [text("Travel")] }),
        node({ node_name: "#text", text_runs: [text("Travel")] }),
      ]),
    ]),
  );
  assert.equal(out, '1 BUTTON "Travel"');
});

// ---- fallbacks ----

test("page text is quoted and numbers are not — in a calendar both are one- or two-digit integers", () => {
  // Without the quotes, the three lines 9 SPAN "28" / 16 SPAN "9" / 112 SPAN "16" give no way to tell
  // which is the number. Keeping the number a bare integer is deliberate: it goes into params.emsn verbatim.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "112", node_name: "SPAN", text_runs: [text("16")] }),
      node({ emsn: "16", node_name: "SPAN", text_runs: [text("9")] }),
    ]),
  );
  assert.equal(out, '112 SPAN "16"\n16 SPAN "9"');
  // The line must start with a bare number so the model can copy it straight into params.emsn.
  for (const line of out.split("\n")) assert.match(line, /^\d+ /);
});


test("a control wrapped by a numbered ancestor still emits a line — otherwise the whole input disappears", () => {
  // The shape of Zhihu's login box: <label emsn=10><input type=tel placeholder="phone number"></label>
  // The ancestor's line can only absorb its descendants' text_runs, never their value or placeholder.
  // Without this extra line the model sees a bare 10 LABEL: it knows it can click, not what to put where.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "10", node_name: "LABEL" }, [
        node({ node_name: "INPUT", type: "tel", placeholder: "phone number" }),
      ]),
    ]),
  );
  assert.equal(out, '10 LABEL\n\t· INPUT:tel hint "phone number"');
});

test("a control's text is still absorbed by the ancestor's line and never appears twice", () => {
  // The line added above emits only the control's own parts. text_runs still roll up — emitting both
  // would say the same sentence twice and waste prompt.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "DIV" }, [
        node({ node_name: "INPUT", value: "Shenzhen", text_runs: [text("Departure city")] }),
      ]),
    ]),
  );
  assert.equal(out, '1 DIV "Departure city"\n\t· INPUT ="Shenzhen"');
});
test("it is not only values and hints the ancestor cannot absorb — a descendant with only a name needs a line too", () => {
  // The roll-up only takes text_runs. A label is the accessible name and is not among them, so an icon
  // button with only a name (close, back) would have nothing left without this line.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "DIV" }, [node({ node_name: "SPAN", label: "Close" })]),
    ]),
  );
  assert.equal(out, '1 DIV\n\t· [Close]');
});

test("a control with no state at all emits no line — a bare \"· INPUT\" is pure noise", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "DIV" }, [node({ node_name: "INPUT", type: "text" })]),
    ]),
  );
  assert.equal(out, "1 DIV");
});


// ---- reading order (bbox) ----
//
// Entries arrive in document order (pdl: "It is not always the visual order; sort by bbox"): four
// cells A B C D in the document can be C D A B on screen.
//
// Without a bbox the original order must be kept — sorting wrongly is worse than not sorting.

const box = (x: number, y: number, w = 20, h = 16) => [x, y, w, h];

test("children are reordered by (row, x), not taken in arrival order", () => {
  // Deliberately shuffled: on screen it is alpha(0,0) beta(30,0) gamma(0,20).
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "3", node_name: "SPAN", bbox: box(0, 20), text_runs: [{ text: "gamma", bbox: box(0, 20) }] }),
      node({ emsn: "1", node_name: "SPAN", bbox: box(0, 0), text_runs: [{ text: "alpha", bbox: box(0, 0) }] }),
      node({ emsn: "2", node_name: "SPAN", bbox: box(30, 0), text_runs: [{ text: "beta", bbox: box(30, 0) }] }),
    ]),
  );
  assert.equal(out, '1 SPAN "alpha"\n2 SPAN "beta"\n3 SPAN "gamma"');
});

test("when a region's box cannot hold its descendants, fall back to their union", () => {
  // Since September 2026 the kernel issues a bbox for regions (bbox but no node_name) too, but measurably on a
  // DPR=2 screen regions use device pixels and elements use CSS pixels, a factor of two apart. The region
  // box here, [0,200,400,100], is the real position [0,100,200,50] doubled — it cannot hold its
  // descendants (which sit near y=100), so it must not be trusted. Trusting it would sort the region
  // (y=200) after element beta (y=150); using the union (y=100) puts the region first.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "9", node_name: "SPAN", bbox: box(0, 150), text_runs: [{ text: "beta", bbox: box(0, 150) }] }),
      // A region: no node_name, and a bbox that has been scaled up.
      node({ bbox: [0, 200, 400, 100] }, [
        node({ emsn: "1", node_name: "SPAN", bbox: box(0, 100), text_runs: [{ text: "alpha", bbox: box(0, 100) }] }),
      ]),
    ]),
  );
  assert.equal(out, '1 SPAN "alpha"\n9 SPAN "beta"');
});

test("when a region's box does hold its descendants, its own box is used", () => {
  // The day the units are right: the region box [0,90,200,80] contains its descendant (y=100), so use it.
  // Element beta is at y=95, after the region — only the region's own box (y=90) sorts them correctly.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "9", node_name: "SPAN", bbox: box(0, 95), text_runs: [{ text: "beta", bbox: box(0, 95) }] }),
      node({ bbox: [0, 90, 200, 80] }, [
        node({ emsn: "1", node_name: "SPAN", bbox: box(0, 100), text_runs: [{ text: "alpha", bbox: box(0, 100) }] }),
      ]),
    ]),
  );
  assert.equal(out, '1 SPAN "alpha"\n9 SPAN "beta"');
});

test("the calendar shape: date cells arriving shuffled are ordered 1,2,3...", () => {
  // Seven cells in a row, arriving in a shuffled order.
  const days = [
    { d: "3", x: 80 },
    { d: "1", x: 0 },
    { d: "5", x: 160 },
    { d: "2", x: 40 },
    { d: "7", x: 240 },
    { d: "4", x: 120 },
    { d: "6", x: 200 },
  ];
  const out = renderAnnotatedContent(
    node(
      undefined,
      days.map((x, i) =>
        node({
          emsn: String(90 + i),
          node_name: "SPAN",
          bbox: box(x.x, 100),
          text_runs: [{ text: x.d, bbox: box(x.x, 100) }],
        }),
      ),
    ),
  );
  assert.deepEqual(
    out.split("\n").map((l) => /"(\d+)"/.exec(l)?.[1]),
    ["1", "2", "3", "4", "5", "6", "7"],
    out,
  );
});

test("elements a few pixels apart in y are still the same row (the tolerance)", () => {
  // An icon at y=100 height 12 and text at y=103 height 16 — visually one row, and sorting strictly by y would split it.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "2", node_name: "SPAN", bbox: box(60, 103, 20, 16), text_runs: [{ text: "right", bbox: box(60, 103, 20, 16) }] }),
      node({ emsn: "1", node_name: "I", bbox: box(10, 100, 12, 12), text_runs: [{ text: "left", bbox: box(10, 100, 12, 12) }] }),
      node({ emsn: "3", node_name: "SPAN", bbox: box(10, 200, 20, 16), text_runs: [{ text: "next row", bbox: box(10, 200, 20, 16) }] }),
    ]),
  );
  assert.equal(out, '1 I "left"\n2 SPAN "right"\n3 SPAN "next row"');
});

test("a sentence broken up by inline markup joins back exactly (the case with the widest reach)", () => {
  // Measured: a three-run sentence joined in array order came out as
  // "part two part three part one". Almost all body text on the web has this shape (<b>/<a>/<code>
  // everywhere), so every snapshot held a batch of scrambled sentences — and with no correct answer to
  // compare against, we never knew.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "1",
        node_name: "P",
        bbox: box(0, 0, 300, 16),
        text_runs: [
          { text: "part two", bbox: box(60, 0) },
          { text: "part three", bbox: box(120, 0) },
          { text: "part one", bbox: box(0, 0) },
        ],
      }),
    ]),
  );
  assert.equal(out, '1 P "part one part two part three"');
});

test("a sentence across rows joins by row order (the upper row first, then the lower)", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "1",
        node_name: "P",
        bbox: box(0, 0, 300, 40),
        text_runs: [
          { text: "bottom left", bbox: box(0, 20) },
          { text: "top right", bbox: box(80, 0) },
          { text: "top left", bbox: box(0, 0) },
          { text: "bottom right", bbox: box(80, 20) },
        ],
      }),
    ]),
  );
  assert.equal(out, '1 P "top left top right bottom left bottom right"');
});

test("text rolled up from different descendants is sorted by position too", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "BUTTON", bbox: box(0, 0, 200, 16) }, [
        node({ node_name: "SPAN", bbox: box(60, 0), text_runs: [{ text: "beta", bbox: box(60, 0) }] }),
        node({ node_name: "SPAN", bbox: box(0, 0), text_runs: [{ text: "alpha", bbox: box(0, 0) }] }),
      ]),
    ]),
  );
  assert.equal(out, '1 BUTTON "alpha beta"');
});

test("text runs within one node join in reading order, not array order", () => {
  // Joining them wrongly hands the model a scrambled sentence. In the old kernel run order was hash order
  // and measurably produced "part two part three part one"; it is document order now, and this case
  // covers the part where document order is not screen order.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "1",
        node_name: "SPAN",
        bbox: box(0, 0, 100, 16),
        text_runs: [
          { text: "second", bbox: box(50, 0) },
          { text: "first", bbox: box(0, 0) },
        ],
      }),
    ]),
  );
  assert.equal(out, '1 SPAN "first second"');
});

// ---- the row-grouping rule ----
//
// The three cases below each watch one defect measured on real corpus: the 15 snapshots with bbox from
// that Ctrip run, against two metrics — wrongly split (the same row ordered with x decreasing) and
// wrongly merged (different rows ordered with y decreasing).
//
//   y differs from the row's first element by <= median height / 2   split 33/1435   merged  0/471
//   vertically overlaps any element of the row                       split  0/1153   merged 68/613
//   the current rule (centre line + height magnitude)                split  4/1427   merged  1/449

/** The bare emsn at the start of each rendered line, as an array in line order. */
const emsnOrder = (out: string) =>
  out.split("\n").map((l) => /^\t*(\d+) /.exec(l)?.[1]);

test("a pure container's position comes from its content — a missing bbox must not abandon the whole batch", () => {
  // Measured on corpus: 431 of 2848 child nodes were pure containers, with children and no fields of
  // their own. "Give up on the whole batch when any sibling lacks a bbox" left 147 of 413 sibling
  // sequences (36%) unsorted. Containers are the **only** nodes missing a bbox.
  const wrap = (x: number, emsn: string) =>
    node(undefined, [
      node({
        emsn,
        node_name: "SPAN",
        bbox: box(x, 0),
        text_runs: [{ text: emsn, bbox: box(x, 0) }],
      }),
    ]);
  const out = renderAnnotatedContent(node(undefined, [wrap(60, "2"), wrap(0, "1")]));
  assert.deepEqual(emsnOrder(out), ["1", "2"], out);
});

test("membership of a row must not depend on which element starts it", () => {
  // Measured on a Ctrip header: y=26 h=20 and y=27 h=18 are both centred at 36 and unquestionably one
  // row, yet they were split — the row started at y=22 with a tolerance of 4, so y=26 got in by a hair
  // at a difference of 4 while y=27 at 5 did not, and the one at x=1401 ended up before x=466.
  const cell = (emsn: string, x: number, y: number, h: number) =>
    node({
      emsn,
      node_name: "SPAN",
      bbox: box(x, y, 20, h),
      text_runs: [{ text: emsn, bbox: box(x, y, 20, h) }],
    });
  const out = renderAnnotatedContent(
    node(undefined, [cell("3", 1401, 26, 20), cell("2", 466, 27, 18), cell("1", 100, 22, 20)]),
  );
  assert.deepEqual(emsnOrder(out), ["1", "2", "3"], out);
});

test("a tall full-width container must not swallow a whole column into one row", () => {
  // This is the cost of the "vertical overlap" rule: a 703px container overlaps every 42px row item in
  // the same column, so the column is merged into one row, sorted by x, and the vertical order is
  // destroyed. On corpus that produces 68/613 wrong merges.
  const row = (emsn: string, x: number, y: number) =>
    node({
      emsn,
      node_name: "DIV",
      bbox: box(x, y, 200, 40),
      text_runs: [{ text: emsn, bbox: box(x, y, 200, 40) }],
    });
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "9",
        node_name: "ASIDE",
        bbox: box(1000, 50, 300, 700),
        text_runs: [{ text: "9", bbox: box(1000, 50, 300, 700) }],
      }),
      row("1", 800, 100),
      row("2", 400, 200),
      row("3", 15, 300),
    ]),
  );
  // The sidebar is at the top (y=50) and the three rows follow by y — even though their x decreases.
  assert.deepEqual(emsnOrder(out), ["9", "1", "2", "3"], out);
});

test("a price with superscript $ and cents beside large digits reads whole", () => {
  // Lowe's search results, measured 2026-10-31: read as "107" and then "$ .24", because 38px is over twice 18px.
  const part = (name: string, s: string, x: number, y: number, w: number, h: number) =>
    node({ node_name: name, bbox: box(x, y, w, h), text_runs: [{ text: s, bbox: box(x, y, w, h) }] });
  const out = renderAnnotatedContent(
    node({ bbox: box(709, 894, 73, 38) }, [
      part("SUP", "$", 709, 899, 9, 18),
      part("SPAN", "107", 717, 894, 45, 38),
      part("SUP", ".24", 761, 899, 21, 18),
    ]),
  );
  assert.match(out, /"\$107\.24"/, out);
});

test("a short box joins a taller row up to 3x only when it sits beside the taller one, within its height", () => {
  const b = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const tall = b(717, 894, 45, 38);
  assert.ok(sameLine(b(709, 899, 9, 18), tall), "superscript beside large digits");
  // A wrapped two-line run (49px) spans both lines' 23px pieces; each line must stay its own row.
  assert.ok(!sameLine(b(541, 211, 96, 23), b(264, 211, 505, 49)), "a piece under a wrapped run");
  assert.ok(!sameLine(b(800, 899, 9, 18), tall), "contained in height but far to the side");
  assert.ok(!sameLine(b(709, 907, 9, 12), tall), "centred, but over 3x");
  assert.ok(!sameLine(b(709, 893.5, 9, 18), tall), "centred, but sticks out above the taller one");
});

// ---- degrading: no bbox ----

test("with no bbox at all, keep the array order and do not blow up", () => {
  // Sorting wrongly is worse than not sorting: document order is at least a stable, known error.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "3", node_name: "SPAN", text_runs: [text("gamma")] }),
      node({ emsn: "1", node_name: "SPAN", text_runs: [text("alpha")] }),
    ]),
  );
  assert.equal(out, '3 SPAN "gamma"\n1 SPAN "alpha"');
});

test("with only some carrying a bbox, keep the original order too (never half sorted)", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "3", node_name: "SPAN", bbox: box(0, 20), text_runs: [text("gamma")] }),
      node({ emsn: "1", node_name: "SPAN", text_runs: [text("alpha")] }),
    ]),
  );
  assert.equal(out, '3 SPAN "gamma"\n1 SPAN "alpha"');
});

test("a misshapen bbox (too short, or not numbers) counts as absent", () => {
  for (const bad of [[1, 2], "x", null, [1, 2, "a", 4]]) {
    const out = renderAnnotatedContent(
      node(undefined, [
        node({ emsn: "2", node_name: "SPAN", bbox: bad, text_runs: [text("beta")] }),
        node({ emsn: "1", node_name: "SPAN", bbox: box(0, 0), text_runs: [text("alpha")] }),
      ]),
    );
    assert.equal(out, '2 SPAN "beta"\n1 SPAN "alpha"', `bbox=${JSON.stringify(bad)}`);
  }
});

test("bbox never appears in the rendered output — coordinates are used and discarded", () => {
  // Printing coordinates costs about 25 characters per element while the whole rendering is 4.5KB, so
  // the prompt would grow by about 80%. And measurably a model of this class cannot do two-dimensional
  // reasoning from coordinates anyway (not even given two aligned images).
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "SPAN", bbox: box(123, 456), text_runs: [{ text: "alpha", bbox: box(123, 456) }] }),
    ]),
  );
  assert.equal(out, '1 SPAN "alpha"');
  for (const n of ["123", "456", "bbox"]) assert.ok(!out.includes(n), out);
});

test("what will not parse is returned unchanged — verbose JSON beats a blank", () => {
  // A blank means the model is blind for that round, which is far worse than spending tokens.
  assert.equal(renderAnnotatedContent("{not valid JSON"), "{not valid JSON");
});

test("a null among children does not blow up — this tree comes from JSON.parse and its shape is not ours to guarantee", () => {
  const out = renderAnnotatedContent({
    children: [null, node({ emsn: "1", node_name: "P", text_runs: [text("alpha")] })],
  });
  assert.equal(out, '1 P "alpha"', "one malformed spot must not blind the whole round");
});

test("children that is not an array counts as no children, and does not blow up", () => {
  assert.equal(renderAnnotatedContent({ children: "oops" }), "");
});

test("empty input does not blow up", () => {
  assert.equal(renderAnnotatedContent(""), "");
  assert.equal(renderAnnotatedContent(undefined), "");
  assert.equal(renderAnnotatedContent(null), "");
});

test("an empty-string emsn counts as no emsn (a number that cannot be clicked must not be rendered)", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "", node_name: "#text", text_runs: [text("NEW")] }),
    ]),
  );
  assert.ok(!out.includes("undefined"), out);
  assert.equal(out, '· "NEW"');
});

test("accepts both a JSON string and an already-parsed object", () => {
  const tree = node(undefined, [
    node({ emsn: "1", node_name: "A", text_runs: [text("alpha")] }),
  ]);
  assert.equal(
    renderAnnotatedContent(JSON.stringify(tree)),
    renderAnnotatedContent(tree),
  );
});

test("indentation is capped so deep nesting does not blow out the line start", () => {
  let deep: ReturnType<typeof node> = node({
    emsn: "99",
    node_name: "SPAN",
    text_runs: [text("bottom")],
  });
  for (let i = 0; i < 10; i++) {
    deep = node({ emsn: String(i), node_name: "DIV" }, [deep]);
  }
  const last = renderAnnotatedContent(deep).split("\n").at(-1)!;
  const tabs = last.length - last.trimStart().length;
  assert.ok(tabs <= 3, `indented ${tabs} levels; the cap should be 3`);
});

// ---- the formal constraint on emsn (a rendered number must be one the executor recognises) ----

test("an emsn that is not pure digits counts as no number", () => {
  // The pdl takes an optional integer emsn, and measured over the corpus all 48402 are pure digits.
  // Letting "a3" through renders `a3 SPAN "x"` — the model sees it and will use it, while collectEmsn
  // scrapes the line start with /^\t*(\d+) / and never collects it, so the executor's gate refuses it.
  // Visible but unusable is the hardest kind of failure to diagnose.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "a3", node_name: "SPAN", text_runs: [text("alpha")] }),
    ]),
  );
  assert.equal(out, '· "alpha"', out);
  assert.ok(!out.includes("a3"), out);
});

test("collectEmsn matches the line-start numbers in the rendered output exactly", () => {
  // This holds "the set of numbers the model sees" and "the set the executor allows" to be one set.
  const tree = node(undefined, [
    node({ emsn: "7", node_name: "INPUT", label: "Origin" }, [
      node({ emsn: "8", node_name: "SPAN", text_runs: [text("Shenzhen")] }),
    ]),
    node({ node_name: "DIV", text_runs: [text("explanatory text with no number")] }),
    node({ emsn: "9", node_name: "BUTTON", text_runs: [text("Search")] }),
  ]);
  const fromLines = new Set(
    renderAnnotatedContent(tree)
      .split("\n")
      .map((l) => /^\t*(\d+) /.exec(l)?.[1])
      .filter((x): x is string => !!x),
  );
  assert.deepEqual([...collectEmsn(tree)].sort(), [...fromLines].sort());
  assert.deepEqual([...collectEmsn(tree)].sort(), ["7", "8", "9"]);
});

test("when the content will not parse, collectEmsn returns the empty set — opening the gate rather than locking it", () => {
  // The renderer returns the content unchanged on a parse failure (deliberately). Scraping raw JSON with
  // a regex is dangerous: a line that happens to start with "123 " gives a wrong little set, and every
  // real number is then refused.
  const broken = '{"children":[{"emsn":"7"\n123 this line would be caught by the line-start regex\n';
  assert.equal(collectEmsn(broken).size, 0);
  // The renderer still hands the content over, so the model can at least see something.
  assert.equal(renderAnnotatedContent(broken), broken);
});

// ---- entry fields ----

test("a region emits no line while its children are still sorted — the rule is node_name, not 'are there fields'", () => {
  // The region here carries a label it should not have: if the rule fell back to field presence, the
  // region would be taken for an element and an extra line "· [should not appear]" would show up.
  // Only testing node_name blocks that.
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ bbox: box(0, 0, 200, 60), label: "should not appear" }, [
        node({ emsn: "2", node_name: "SPAN", bbox: box(50, 0), text_runs: [{ text: "beta", bbox: box(50, 0) }] }),
        node({ emsn: "1", node_name: "SPAN", bbox: box(0, 0), text_runs: [{ text: "alpha", bbox: box(0, 0) }] }),
      ]),
    ]),
  );
  assert.equal(out, '1 SPAN "alpha"\n2 SPAN "beta"');
});

test("with no checked key, nothing is written — that is 'no checked state', not 'unchecked'", () => {
  const withKey = renderAnnotatedContent(
    node(undefined, [node({ emsn: "1", node_name: "INPUT", type: "radio", checked: false })]),
  );
  const without = renderAnnotatedContent(
    node(undefined, [node({ emsn: "1", node_name: "INPUT", type: "radio" })]),
  );
  assert.equal(withKey, "1 INPUT:radio unchecked");
  assert.equal(without, "1 INPUT:radio", "writing unchecked out of nowhere invents a state the page never declared");
});

test("value and placeholder look different — treating grey text as entered content is unrecoverable", () => {
  const filled = renderAnnotatedContent(
    node(undefined, [node({ emsn: "1", node_name: "INPUT", type: "text", value: "Shanghai" })]),
  );
  const empty = renderAnnotatedContent(
    node(undefined, [node({ emsn: "1", node_name: "INPUT", type: "text", placeholder: "Enter departure city" })]),
  );
  assert.equal(filled, '1 INPUT:text ="Shanghai"');
  assert.equal(empty, '1 INPUT:text hint "Enter departure city"');
  assert.notEqual(filled.replace("Shanghai", "X"), empty.replace("Enter departure city", "X"));
});

test("an empty value or label takes no room", () => {
  const out = renderAnnotatedContent(
    node(undefined, [node({ emsn: "1", node_name: "INPUT", type: "text", value: "", label: "  " })]),
  );
  assert.equal(out, "1 INPUT:text");
});

test("a disabled control has no number, but its value must still be carried out", () => {
  // A locked departure city: the model cannot click it, but it must know what is already in it.
  const out = renderAnnotatedContent(
    node(undefined, [node({ node_name: "INPUT", type: "text", value: "Shanghai", disabled: true })]),
  );
  assert.equal(out, '· INPUT:text ="Shanghai" disabled');
});

test("an editable area's lines and styled parts stay on its one line, written as browser_input_text copies them", () => {
  // A mail body's value has line breaks; a raw one would start a new snapshot line.
  const tree = node(undefined, [
    node({
      emsn: 2,
      node_name: "BODY",
      value: '收到，\n我很‸喜欢 "这个"',
      formats: [
        { text: "喜欢", style: ["bold", "italic"] },
        { text: "好", occurrence: 2, style: ["bold"] },
        { text: "官网", style: ["link"], href: "https://example.com/" },
        { from: "原邮件", to: "完成。", style: ["quote"] },
      ],
    }),
  ]);
  assert.equal(
    renderAnnotatedContent(tree),
    '2 BODY ="收到，\\n我很‸喜欢 \\"这个\\"" formats bold+italic "喜欢", bold "好" #2, ' +
      'link "官网" https://example.com/, quote from "原邮件" to "完成。"',
  );
});

test("formats are for acting: left out when reading, and malformed entries are skipped", () => {
  const area = (formats: unknown) =>
    node(undefined, [node({ emsn: 2, node_name: "DIV", value: "a 好", formats })]);
  const good = [{ text: "好", style: ["bold"] }];
  assert.equal(renderAnnotatedContent(area(good), { numbers: false }), 'DIV ="a 好"');
  assert.equal(renderAnnotatedContent(area("bold")), '2 DIV ="a 好"');
  assert.equal(renderAnnotatedContent(area([])), '2 DIV ="a 好"');
  assert.equal(
    renderAnnotatedContent(area([null, "x", { text: "好" }, { text: "a", style: ["italic"], occurrence: "x" }])),
    '2 DIV ="a 好" formats "好", italic "a"',
  );
});

test("an empty editable area still shows it takes typing; an empty input needs no mark", () => {
  const tree = node(undefined, [
    node({ emsn: 0, node_name: "DIV", value: "" }),
    node({ emsn: 1, node_name: "INPUT", type: "text", value: "" }),
  ]);
  assert.equal(renderAnnotatedContent(tree), '0 DIV =""\n1 INPUT:text');
});

test("a read-only field says so", () => {
  // A booking site's date box: typing is refused, a click opens the page's calendar.
  const tree = node(undefined, [node({ emsn: 3, node_name: "INPUT", type: "text", value: "2026-12-25", readonly: true })]);
  assert.equal(renderAnnotatedContent(tree), '3 INPUT:text ="2026-12-25" readonly');
  // Only aria-readonly: the kernel still types into it, so it must not read as refused.
  const declared = node(undefined, [node({ emsn: 4, node_name: "INPUT", type: "text", readonly: "declared" })]);
  assert.equal(renderAnnotatedContent(declared), "4 INPUT:text aria-readonly");
});

test("a cut text run gives the full text, not the painted fragment", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({
        emsn: "1", node_name: "DIV", bbox: box(0, 0, 80, 16),
        text_runs: [{ text: "Sanya Atlantis", bbox: box(0, 0, 80, 16), visibility: "cut", full_text: "Sanya Atlantis Resort Hotel" }],
      }),
    ]),
  );
  assert.equal(out, '1 DIV "Sanya Atlantis Resort Hotel"');
});

test("marked cut without a full_text falls back to the painted fragment", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "1", node_name: "DIV", bbox: box(0, 0, 80, 16),
             text_runs: [{ text: "half a sen", bbox: box(0, 0, 80, 16), visibility: "cut" }] }),
    ]),
  );
  assert.equal(out, '1 DIV "half a sen"', "a fragment beats losing the text over a missing field");
});

// Since kernel 6e1162eb2d a clamped paragraph's last run carries its own line plus what is cut
// after it; a word of the first line recurring later must not drop that line.
test("a clamped paragraph reads once, each run by its full_text or its text", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ node_name: "DIV", bbox: box(0, 0, 200, 40), text_runs: [
        { text: "one", bbox: box(0, 0, 200, 20) },
        { text: "two", bbox: box(0, 20, 200, 20), visibility: "cut", full_text: "two one three END" },
      ] }),
    ]),
  );
  assert.equal(out, '· "one two one three END"');
});

test("text in a closed DETAILS is marked collapsed, after its summary; reading gives it plain", () => {
  const tree = node(undefined, [
    node({ node_name: "DETAILS", text_runs: [{ text: "G1 line\nG2 line", visibility: "unseen" }] }, [
      node({ emsn: "2", node_name: "SUMMARY", bbox: box(0, 0, 100, 20), text_runs: [text("More")] }),
    ]),
  ]);
  assert.equal(renderAnnotatedContent(tree), '2 SUMMARY "More"\n· "G1 line G2 line" collapsed');
  assert.equal(renderAnnotatedContent(tree, { numbers: false }), 'SUMMARY "More"\nG1 line G2 line');
});

test("the F0 marks: modal, a SELECT's options, hover-only, other actions, an unread frame", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ node_name: "DIALOG", modal: true, bbox: box(0, 0, 100, 100) }),
      node({ emsn: "1", node_name: "SELECT", value: "Melbourne", options: ["Sydney", "Melbourne"], bbox: box(0, 100, 100, 20) }),
      node({ emsn: "2", node_name: "DIV", certainty: "hover", bbox: box(0, 120, 100, 20), text_runs: [text("Tip")] }),
      node({ emsn: "3", node_name: "DIV", certainty: "listener", actions: { dblclick: 3, drag: 3 }, bbox: box(0, 140, 100, 20), text_runs: [text("Row")] }),
      node({ emsn: "4", node_name: "IFRAME", unread: true, bbox: box(0, 160, 100, 20) }),
    ]),
  );
  assert.equal(
    out,
    [
      "· DIALOG modal",
      '1 SELECT ="Melbourne" options "Sydney" "Melbourne"',
      '2 DIV "Tip" hover-only',
      '3 DIV "Row" also dblclick, drag',
      "4 IFRAME not loaded yet",
    ].join("\n"),
  );
});

// b492e02e66: an AG Grid cell carries the table's double-click and right-click; "click" only says
// an enclosing element handles the click, which acting on the number does anyway.
test("actions: every listed one but click is told, whoever handles it", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ emsn: "5", node_name: "DIV", actions: { click: 2, dblclick: 2, right_click: null, wheel: 5 }, bbox: box(0, 0, 100, 20), text_runs: [text("Cell")] }),
      node({ emsn: "6", node_name: "DIV", actions: { click: 2 }, bbox: box(0, 20, 100, 20), text_runs: [text("Item")] }),
    ]),
  );
  assert.equal(out, '5 DIV "Cell" also dblclick, right_click, wheel\n6 DIV "Item"');
});

test("a long option list is cut, saying how many more there are", () => {
  const options = Array.from({ length: 35 }, (_, i) => `C${i}`);
  const out = renderAnnotatedContent(node(undefined, [node({ emsn: "1", node_name: "SELECT", options })]));
  assert.match(out, /"C29" and 5 more$/);
  assert.doesNotMatch(out, /"C30"/);
});

// Every scroller is numbered, including an app's main pane, which holds nearly the whole
// page. Folding its text into one line (as a numbered element does) would bury the structure.
test("a numbered scroller keeps only its own text; its contents get their own lines", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node(
        { emsn: "0", node_name: "DIV", bbox: [180, 0, 1207, 857], scroll_width: 1192, scroll_height: 5034, scroll_x: 0, scroll_y: 0 },
        [node({ node_name: "P", text_runs: [text("MAIN-TOP")] }), node({ emsn: "4", node_name: "A", text_runs: [text("open")] })],
      ),
    ]),
  );
  assert.equal(out, '0 DIV scrollable: 4177px more below\n\t· "MAIN-TOP"\n\t4 A "open"');
});

test("a scroller on the scroll chain uses the kernel's exact figures", () => {
  const out = renderAnnotatedContent({
    current_scroll_chain: [{ emsn: "0", node_name: "DIV", up: 0, down: 4177, left: 0, right: 0 }],
    children: [node({ emsn: "0", node_name: "DIV", bbox: [0, 0, 100, 857], scroll_height: 5034, scroll_y: 0 })],
  });
  assert.equal(out, "0 DIV scrollable: 4177px more below");
});

test("page position: a long page says where this screen is and how much is below", () => {
  const pos = renderPagePosition({
    viewport: { width: 1372, height: 857, scroll_x: 0, scroll_y: 1714 },
    page: { width: 1372, height: 10497 },
    current_scroll_chain: [{ emsn: "-1", node_name: "page", up: 1714, down: 7926, left: 0, right: 0 }],
    children: [],
  });
  assert.match(pos, /10497px tall/);
  assert.match(pos, /shows 1714-2571/);
  assert.match(pos, /screen 3 of 13/);
  assert.match(pos, /7926px more below/);
  assert.doesNotMatch(pos, /without emsn/, "when a plain scroll moves the page there is nothing more to say");
});

// Mail, dashboards, chat: the document does not scroll, so its size alone reads "nothing more".
test("page position: an app-style page says the page does not scroll and what a scroll moves", () => {
  const pos = renderPagePosition({
    viewport: { width: 1387, height: 857, scroll_x: 0, scroll_y: 0 },
    page: { width: 1387, height: 857 },
    current_scroll_chain: [
      { emsn: "0", node_name: "DIV", up: 0, down: 4177, left: 0, right: 0 },
      { node_name: "page", up: 0, down: 0, left: 0, right: 0 },
    ],
    children: [],
  });
  assert.match(pos, /does not scroll/);
  assert.match(pos, /moves 0 DIV \(4177px more below\), then the page \(at its end\)/);
  assert.doesNotMatch(pos, /emsn -1/, "-1 is offered only when the kernel verified it");
});

test("page position: -1 is mentioned only when the chain's page link carries it", () => {
  const pos = renderPagePosition({
    viewport: { height: 857, scroll_y: 0 },
    page: { height: 1796 },
    current_scroll_chain: [
      { emsn: "2", node_name: "DIV", down: 625 },
      { emsn: "-1", node_name: "page", down: 939 },
    ],
    children: [],
  });
  assert.match(pos, /scroll with emsn -1/);
});

test("long read: elements off the image are marked, and the position line counts them", () => {
  const tree = {
    viewport: { width: 1000, height: 800, scroll_x: 0, scroll_y: 0 },
    page: { width: 1000, height: 5000 },
    content_bbox: [0, 0, 1000, 5000],
    children: [
      node({ emsn: "1", node_name: "A", text_runs: [text("top")] }),
      node({ emsn: "2", node_name: "A", shown: "partial", text_runs: [text("edge")] }),
      node({ emsn: "3", node_name: "A", shown: "no", text_runs: [text("far")] }),
    ],
  };
  assert.equal(
    renderAnnotatedContent(tree),
    '1 A "top"\n2 A "edge" partly offscreen\n3 A "far" offscreen',
  );
  assert.match(renderPagePosition(tree), /long read.*2 of its 3 numbered elements are off the image/);
});

test("an ordinary snapshot says nothing about a long read", () => {
  const pos = renderPagePosition({
    viewport: { width: 1000, height: 800, scroll_y: 0 },
    page: { height: 5000 },
    content_bbox: [0, 0, 1000, 800],
    children: [],
  });
  assert.doesNotMatch(pos, /long read/);
});

test("page position: an older kernel without the fields yields nothing", () => {
  assert.equal(renderPagePosition({ viewport: { width: 1, height: 1 }, children: [] }), "");
});

// Bing's answer card put every word in its own span, which read one word per line.
test("bare words on one screen line join into one line; a new line or a numbered element breaks the run", () => {
  const word = (s: string, x: number, y: number) =>
    node({ node_name: "SPAN", bbox: [x, y, 30, 16], text_runs: [text(s)] });
  const out = renderAnnotatedContent(
    node(undefined, [
      word("31", 0, 0),
      word("October", 40, 0),
      word("2026", 80, 0),
      word("When", 0, 40),
      word("is", 40, 40),
      node({ emsn: "5", node_name: "A", bbox: [80, 40, 30, 16], text_runs: [text("due")] }),
      word("date", 120, 40),
    ]),
  );
  assert.equal(out, '· "31 October 2026"\n· "When is"\n5 A "due"\n· "date"');
});

test("a table's empty cells that are only offscreen say nothing", () => {
  const out = renderAnnotatedContent(
    node(undefined, [
      node({ node_name: "TD", shown: "no" }),
      node({ node_name: "TD", shown: "no", text_runs: [text("15 May 2027")] }),
    ]),
  );
  assert.equal(out, '· "15 May 2027" offscreen');
});

// Since late September 2026 emsn is an integer, and 0 is a real number: a truthiness test would drop it.
test("integer emsn, 0 included, renders and is collected", () => {
  const tree = node(undefined, [
    node({ emsn: 0, node_name: "A", text_runs: [text("first")] }),
    node({ emsn: 7, node_name: "BUTTON", text_runs: [text("go")] }),
  ]);
  assert.equal(renderAnnotatedContent(tree), '0 A "first"\n7 BUTTON "go"');
  assert.deepEqual([...collectEmsn(tree)].sort(), ["0", "7"]);
});

// An address sits on the entries inside a link, once per link.
test("links: a line marks the addresses of what it folds in; an address keeps a word out of a merge", () => {
  const tree = node(undefined, [
    node({ emsn: 3, node_name: "DIV", label: "result" }, [
      node({ node_name: "SPAN", href: "https://a.example/x", text_runs: [text("Title")] }),
      node({ node_name: "SPAN", href: "https://a.example/x", text_runs: [text("snippet")] }),
    ]),
    node({ node_name: "SPAN", bbox: [0, 100, 30, 16], text_runs: [text("see")] }),
    node({ node_name: "SPAN", bbox: [40, 100, 30, 16], href: "https://b.example/", text_runs: [text("here")] }),
  ]);
  assert.equal(
    renderAnnotatedContent(tree, { links: true }),
    '3 DIV [result] "Title snippet" [^1]\n· "see"\n· "here" [^2]\n\n[^1]: https://a.example/x\n[^2]: https://b.example/',
  );
  assert.doesNotMatch(renderAnnotatedContent(tree), /\[\^/, "addresses only when asked");
});

// Google splits a result's snippet at each highlighted word; each piece carries the same address.
test("links: one address is one footnote however often it appears", () => {
  const piece = (s: string, y: number, href?: string) =>
    node({ node_name: "EM", bbox: [0, y, 30, 16], ...(href ? { href } : {}), text_runs: [text(s)] });
  const out = renderAnnotatedContent(
    node(undefined, [
      piece("one", 0, "https://a.example/"),
      piece("two", 40, "https://a.example/"),
      piece("plain", 80),
      piece("other", 120, "https://b.example/"),
      piece("three", 160, "https://a.example/"),
    ]),
    { links: true },
  );
  assert.equal(
    out,
    '· "one" [^1]\n· "two" [^1]\n· "plain"\n· "other" [^2]\n· "three" [^1]\n\n[^1]: https://a.example/\n[^2]: https://b.example/',
  );
});

// Measured on example.com (2026-09-29) and a spacing page: each character in its own span read
// "T h i s", and deduplicating by text alone turned "hello" into "helo".
test("text pieces: touching ones join, white space in the text is kept, a repeat at another spot is content, a repeat in the same spot is not", () => {
  const ch = (c: string, x: number, y = 0, w = 10) => node({ node_name: "SPAN", bbox: [x, y, w, 20], text_runs: [{ text: c, bbox: [x, y, w, 20] }] });
  const word = (s: string, x: number, w: number, y: number) =>
    node({ node_name: "B", bbox: [x, y, w, 20], text_runs: [{ text: s, bbox: [x, y, w, 20] }] });
  const out = renderAnnotatedContent(
    node(undefined, [
      ch("h", 0), ch("e", 10), ch("l", 20), ch("l", 30), ch("o", 40),
      word("Hello ", 0, 50, 40), word("world", 50, 40, 40),
      ch("该", 0, 80, 16), ch("域", 16, 80, 16),
      node({ node_name: "P", bbox: [0, 120, 100, 20], text_runs: [
        { text: "twice", bbox: [0, 120, 50, 20] },
        { text: "twice", bbox: [0, 120, 50, 20] },
      ] }),
    ]),
    { numbers: false },
  );
  assert.equal(out, '"hello"\n"Hello world"\n"该域"\n"twice"');
});

test("bare words on one line: the line is offscreen when all are, partly when some are", () => {
  const word = (s: string, x: number, y: number, shown?: string) =>
    node({ node_name: "SPAN", bbox: [x, y, 30, 16], ...(shown ? { shown } : {}), text_runs: [text(s)] });
  const out = renderAnnotatedContent(
    node(undefined, [
      word("gone", 0, 0, "no"), word("away", 40, 0, "no"),
      word("half", 0, 40), word("seen", 40, 40, "no"),
    ]),
  );
  assert.equal(out, '· "gone away" offscreen\n· "half seen" partly offscreen');
});

test("reading: no offscreen marks, and a numbered element's per-character children read as one word", () => {
  const ch = (c: string, x: number) =>
    node({ node_name: "SPAN", bbox: [x, 0, 10, 20], shown: "no", text_runs: [{ text: c, bbox: [x, 0, 10, 20] }] });
  const tree = node(undefined, [
    node({ emsn: 4, node_name: "A", bbox: [0, 0, 50, 20], shown: "no" }, ["h", "e", "l", "l", "o"].map((c, i) => ch(c, i * 10))),
  ]);
  assert.equal(renderAnnotatedContent(tree, { numbers: false }), 'A "hello"');
  assert.match(renderAnnotatedContent(tree), /^4 A "hello" offscreen$/);
});

test("footnoteList leaves out numbers that name no address", () => {
  assert.equal(footnoteList(["https://a.example/", "https://b.example/"], [1, 0, 3, -1, 2]), "[^1]: https://a.example/\n[^2]: https://b.example/");
  assert.equal(footnoteList([], [1]), "");
});

// ---- boundaries ----

test("an empty tree renders nothing, collects nothing, adds no footnote block and no position", () => {
  assert.equal(renderAnnotatedContent({}), "");
  assert.equal(renderAnnotatedContent({ children: [] }, { links: true }), "");
  assert.equal(collectEmsn({}).size, 0);
  assert.equal(renderPagePosition("{not valid JSON"), "");
  assert.equal(renderPagePosition({}), "");
});

test("the kernel's caret, selection and escape marks in a value pass through as they are", () => {
  // browser_input_text's place parameters take them back verbatim, so nothing may be re-escaped.
  const tree = node(undefined, [
    node({ emsn: 1, node_name: "INPUT", type: "text", value: "a⟦bc⟧d¤‸e‸" }),
    // An empty focused field: the caret mark alone, and the hint beside it.
    node({ emsn: 2, node_name: "INPUT", type: "search", value: "‸", placeholder: "Search" }),
  ]);
  assert.equal(renderAnnotatedContent(tree), '1 INPUT:text ="a⟦bc⟧d¤‸e‸"\n2 INPUT:search ="‸" hint "Search"');
});

test("very long text is carried whole, not cut", () => {
  const long = "word ".repeat(2000).trim();
  const out = renderAnnotatedContent(node(undefined, [node({ emsn: 1, node_name: "P", text_runs: [text(long)] })]));
  assert.equal(out, `1 P "${long}"`);
});

test("nested frames: a frame's content is indented under it, and an unread frame says so", () => {
  const tree = node(undefined, [
    node({ emsn: 1, node_name: "IFRAME", bbox: [0, 0, 500, 400], scroll_width: 500, scroll_height: 1000, scroll_y: 0 }, [
      node({ emsn: 2, node_name: "A", bbox: [0, 0, 50, 20], text_runs: [text("in frame")] }),
      node({ emsn: 3, node_name: "IFRAME", bbox: [0, 100, 300, 200] }, [
        node({ emsn: 4, node_name: "A", bbox: [0, 100, 50, 20], text_runs: [text("deeper")] }),
      ]),
      node({ emsn: 5, node_name: "IFRAME", unread: true, bbox: [0, 350, 300, 40] }),
    ]),
  ]);
  assert.equal(
    renderAnnotatedContent(tree),
    '1 IFRAME scrollable: 600px more below\n\t2 A "in frame"\n\t3 IFRAME\n\t\t4 A "deeper"\n\t5 IFRAME not loaded yet',
  );
  assert.deepEqual([...collectEmsn(tree)].sort(), ["1", "2", "3", "4", "5"]);
});

// A pane scrolled by a fraction of a pixel (common at 150% zoom) is not "0px above".
test("sub-pixel scroll room is not written as 0px", () => {
  const out = renderAnnotatedContent(
    node(undefined, [node({ emsn: 1, node_name: "DIV", bbox: [0, 0, 100, 400.2], scroll_height: 1000.6, scroll_y: 0.3 })]),
  );
  assert.equal(out, "1 DIV scrollable: 600px more below");
  const pos = renderPagePosition({ viewport: { width: 1000, height: 800, scroll_y: 4199.7 }, page: { height: 5000 }, children: [] });
  assert.match(pos, /this is the bottom\./);
});

// "· not loaded yet" alone would not say what is not loaded.
test("an unnumbered unread frame names its tag", () => {
  const out = renderAnnotatedContent(node(undefined, [node({ node_name: "IFRAME", unread: true })]));
  assert.equal(out, "· IFRAME not loaded yet");
});

test("page position: the last screen reads N of N and says it is the bottom; fractions are rounded", () => {
  const pos = renderPagePosition({
    viewport: { width: 1000, height: 800, scroll_y: 4200.3 },
    page: { height: 5000 },
    children: [],
  });
  assert.match(pos, /5000px tall and this screen shows 4200-5000 of it \(screen 7 of 7, one screen = 800px\); this is the bottom\./);
});

test("page position: a chain link missing its figures is at its end; one without a number is an unnumbered pane", () => {
  const pos = renderPagePosition({
    viewport: { height: 800, scroll_y: 0 },
    page: { height: 800 },
    current_scroll_chain: [{ node_name: "DIV" }, { node_name: "page" }],
    children: [],
  });
  assert.match(pos, /moves an unnumbered pane DIV \(at its end\), then the page \(at its end\)\./);
});