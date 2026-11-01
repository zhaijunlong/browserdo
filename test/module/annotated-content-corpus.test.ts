// Run the renderer against the real snapshots stored in the repository.
//
// The unit tests use hand-built little trees and cannot cover the shapes of real pages — the
// first version of the renderer was **green across every unit test** while losing text in 182 of
// 1195 real snapshots. Losing text is silent: what the model cannot see it treats as absent from
// the page, with no error anywhere. So this has to run against real corpus.
//
// The corpus directory is **run/corpus**, kept apart from the runtime's output directory
// (run/browser_data), and that separation was learned the hard way: one pass of the action tests
// throws dozens of synthetic snapshots into the runtime directory, and mixing them in dilutes
// both the count and the conclusions here — that directory once held 3941 files of which 3594
// were exactly this kind of residue. The corpus holds only snapshots of real pages.
//
// The directory is not in the repository (it is a run artefact); without it the whole group is
// skipped — changing machine must not produce a false red.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

import { renderAnnotatedContent } from "../../src/annotated_content.js";
import {
  FLAT_GROUP_LIMIT,
  worstFlatGroup,
} from "../helpers/sibling-groups.js";

const DIR = process.env.EMBIODY_CORPUS_DIR ?? "run/corpus";
const files = fs.existsSync(DIR)
  ? fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith("_content.json"))
      .map((f) => path.join(DIR, f))
  : [];

/**
 * Every non-empty text run in a tree.
 *
 * **Collected per run, not joined per node.** Several runs from one node do not necessarily appear
 * consecutively in the rendered output — a child's own line may come between them. Joining per node
 * into one string and searching for it gives a false red; checking per run is the invariant we
 * actually want to hold: **every run must be findable in the rendered output**.
 *
 * **A cut run needs its full text.** The renderer emits `full_text` wherever a run has one;
 * not following suit here would search the rendered output for the painted fragment, fail to find
 * it, and go falsely red.
 */
function everyText(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return out;
  const n = node as {
    text_runs?: Array<{
      text?: unknown;
      full_text?: unknown;
    }>;
    children?: unknown[];
  };
  for (const run of n.text_runs ?? []) {
    const raw = run?.full_text !== undefined ? run.full_text : run?.text;
    const t = String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (t) out.add(t);
  }
  for (const c of n.children ?? []) everyText(c, out);
  return out;
}

describe("the annotatedContent renderer, against real snapshot corpus", () => {
  it(`the corpus exists (${files.length} files)`, function () {
    if (!files.length) {
      // Do not go falsely red without corpus, but say plainly that this group did not really run.
      console.log(`  (no snapshots under ${DIR}; this group is skipped — one real task run produces them)`);
    }
    assert.ok(true);
  });

  it("not one file loses text", () => {
    if (!files.length) return;
    const bad: string[] = [];
    for (const f of files) {
      let tree: unknown;
      try {
        tree = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue; // a truncated file on disk is not the renderer's fault
      }
      const rendered = renderAnnotatedContent(tree);
      const lost = [...everyText(tree)].filter((s) => !rendered.includes(s));
      if (lost.length) {
        bad.push(`${path.basename(f)} lost ${JSON.stringify(lost.slice(0, 3))}`);
      }
    }
    assert.deepEqual(
      bad.slice(0, 5),
      [],
      `${bad.length}/${files.length} files lost text:\n${bad.slice(0, 5).join("\n")}`,
    );
  });

  it("it really does save space (at least half overall)", () => {
    if (!files.length) return;
    let before = 0;
    let after = 0;
    for (const f of files) {
      const raw = fs.readFileSync(f, "utf8");
      let tree: unknown;
      try {
        tree = JSON.parse(raw);
      } catch {
        continue;
      }
      before += raw.length;
      after += renderAnnotatedContent(tree).length;
    }
    const saved = 100 - (100 * after) / before;
    console.log(
      `  ${files.length} files: ${(before / 1e6).toFixed(2)}M -> ${(after / 1e6).toFixed(2)}M chars, ${saved.toFixed(1)}% saved`,
    );
    // Measured at 88%. The assertion sits at 50%, leaving plenty of room for page shapes to change —
    // this guards against "the renderer was changed back into emitting raw JSON", not against a number.
    assert.ok(saved > 50, `only ${saved.toFixed(1)}% saved; the renderer may have stopped working`);
  });

  it("not one emsn the kernel issued may be lost in the rendered output", () => {
    // This guards against the failure of "the model can see the text but cannot get the number": the
    // first renderer missed one place that carried numbers, turning 10149 clickable targets (39%) in
    // the whole corpus unclickable, while the test suite of the day was entirely green — because it
    // only checked whether text was lost, never whether numbers were.
    //
    // **Correction on the record**: the place it missed was the emsn on text runs. Since September 2026 the
    // kernel issues numbers only on entries — measured on 0.9.0.0, all 635 numbers across 10 pages
    // were on entries and none of the 512 text runs carried one — so both the renderer and this test
    // read entries only. Should the kernel ever number text runs again, the symptom is the paragraph above.
    if (!files.length) return;
    const bad: string[] = [];
    for (const f of files.slice(0, 300)) {
      let tree: unknown;
      try {
        tree = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      const want = new Set<string>();
      (function walk(n: unknown): void {
        if (!n || typeof n !== "object") return;
        const x = n as { emsn?: unknown; children?: unknown[] };
        // Digits only — the same yardstick as the renderer's usable(), or this goes falsely red over a difference in rule
        const own = String(x.emsn ?? "").trim();
        if (/^\d+$/.test(own)) want.add(own);
        for (const c of x.children ?? []) walk(c);
      })(tree);

      const rendered = renderAnnotatedContent(tree);
      const got = new Set(
        [...rendered.matchAll(/^\t*(\d+) /gm)].map((m) => m[1]),
      );
      const missing = [...want].filter((e) => !got.has(e));
      if (missing.length) {
        bad.push(
          `${path.basename(f)} is missing ${missing.length} numbers (such as ${missing.slice(0, 5).join(", ")})`,
        );
      }
    }
    assert.deepEqual(
      bad.slice(0, 5),
      [],
      `${bad.length} files lost clickable numbers — the model sees the text and cannot click it:\n${bad.slice(0, 5).join("\n")}`,
    );
  });

  it("not one name, value or hint may be lost in the rendered output", () => {
    // These three are **never rolled up** (the roll-up only takes text_runs), so each has to reach a
    // line of its own. Losing one means the model sees a clickable number without knowing what to put
    // where — Zhihu's login box, `<label emsn=10><input type=tel placeholder="phone">`, leaked exactly
    // here, while the "loses no text" test stayed green: a placeholder is not text.
    if (!files.length) return;
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      let tree: unknown;
      try {
        tree = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      const rendered = renderAnnotatedContent(tree);
      (function walk(n: unknown): void {
        if (!n || typeof n !== "object") return;
        const x = n as Record<string, unknown> & { children?: unknown[] };
        for (const k of ["label", "value", "placeholder"]) {
          const raw = String(x[k] ?? "").trim();
          if (!raw) continue;
          // As the renderer writes them: a value JSON-quoted (an editable area's line breaks), the
          // others as they are.
          const v = k === "value" ? JSON.stringify(String(x[k])) : raw;
          checked++;
          if (!rendered.includes(v)) bad.push(`${path.basename(f)} lost ${k}=${JSON.stringify(raw)}`);
        }
        for (const c of x.children ?? []) walk(c);
      })(tree);
    }
    console.log(`  checked ${checked} names/values/hints`);
    assert.deepEqual(bad.slice(0, 5), [], bad.slice(0, 5).join("\n"));
  });

  it("no flattened sibling groups — flattening gets a whole batch of reading order wrong", () => {
    // If the kernel flattens block containers again, a whole section of a page becomes one flat layer
    // of dozens of children, and our layered sort degenerates into a single global sort over the
    // viewport: the main column and the sidebar are read a line at a time, alternately, and a product
    // grid reads as "a row of images" then "a row of titles". For the rule and the threshold see
    // helpers/sibling-groups.ts.
    if (!files.length) return;
    let worst: { file: string; size: number; rows: number; cols: number } | null = null;
    for (const f of files) {
      let tree: unknown;
      try {
        tree = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      const g = worstFlatGroup(tree);
      if (g && (!worst || g.size > worst.size)) {
        worst = { file: path.basename(f), ...g };
      }
    }
    console.log(
      worst
        ? `  largest two-dimensional sibling group ${worst.size} (${worst.rows} rows x ${worst.cols} columns) - ${worst.file}`
        : "  no two-dimensional sibling group in the corpus",
    );
    assert.ok(
      !worst || worst.size <= FLAT_GROUP_LIMIT,
      `${worst?.file} holds a two-dimensional sibling group of ${worst?.size} children` +
        ` (${worst?.rows} rows x ${worst?.cols} columns), above the cap of ${FLAT_GROUP_LIMIT} —` +
        ` most likely the kernel flattened block containers again; start with that page's annotated image`,
    );
  });

  it("bbox is either present throughout a file or absent throughout (never half and half)", () => {
    // Since September 2026 every node and every text run carries a bbox. Most local corpus predates that and
    // has none at all, so the rule is **conditional completeness**: only when a snapshot shows a bbox
    // anywhere is it required everywhere. Old and new corpus then mix without a false red, while the
    // kernel omitting one class of node in future is caught — and omitting one is silent, since
    // readingOrder degrades the whole batch the moment a position is missing.
    if (!files.length) return;
    const bad: string[] = [];
    let withBbox = 0;
    for (const f of files) {
      const raw = fs.readFileSync(f, "utf8");
      if (!raw.includes('"bbox"')) continue;
      withBbox++;
      let tree: unknown;
      try {
        tree = JSON.parse(raw);
      } catch {
        continue;
      }
      let nodes = 0;
      let nodesMissing = 0;
      let runs = 0;
      let runsMissing = 0;
      (function walk(n: unknown): void {
        if (!n || typeof n !== "object") return;
        const x = n as {
          node_name?: unknown;
          bbox?: unknown;
          text_runs?: Array<{ bbox?: unknown; visibility?: unknown }>;
          children?: unknown[];
        };
        // Count page elements only. Regions (no node_name, only a bbox) and plain wrappers are outside this rule.
        if (x.node_name !== undefined) {
          nodes++;
          if (!Array.isArray(x.bbox)) nodesMissing++;
          for (const run of x.text_runs ?? []) {
            // A closed DETAILS's text has no bbox by contract (pdl: visibility "unseen").
            if (run?.visibility === "unseen") continue;
            runs++;
            if (!Array.isArray(run?.bbox)) runsMissing++;
          }
        }
        for (const c of x.children ?? []) walk(c);
      })(tree);
      if (nodesMissing || runsMissing) {
        bad.push(
          `${path.basename(f)}: ${nodesMissing}/${nodes} nodes without a bbox, ${runsMissing}/${runs} text runs without one`,
        );
      }
    }
    console.log(
      `  ${withBbox}/${files.length} files carry bbox${withBbox ? "" : " (no run yet with a build from September 2026 or later)"}`,
    );
    assert.deepEqual(bad.slice(0, 5), [], bad.slice(0, 5).join("\n"));
  });

  it("the rendered output shows no undefined / null traces of a missing field", () => {
    if (!files.length) return;
    const bad: string[] = [];
    for (const f of files.slice(0, 200)) {
      let tree: unknown;
      try {
        tree = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        continue;
      }
      const r = renderAnnotatedContent(tree);
      // Match whole words: the word "undefined" may legitimately appear in page text, but not where a line's number goes
      if (/(^|\n)\s*undefined /.test(r)) bad.push(path.basename(f));
    }
    assert.deepEqual(bad.slice(0, 3), [], `undefined where a number should be: ${bad.join(", ")}`);
  });
});
