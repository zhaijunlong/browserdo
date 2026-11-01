#!/usr/bin/env node
// Expand a stored annotatedContent into the flat text the model sees, to answer the question
// asked most often while troubleshooting: what interactive elements were on the page that round,
// and what is the emsn the model clicked.
//
//   node scripts/dump-snapshot.mjs run/browser_data/xxx_content.json
//   node scripts/dump-snapshot.mjs --round 5            # the latest file for that round
//   node scripts/dump-snapshot.mjs --round 5 --grep input
//
// **Deliberately uses the same renderer as the prompt** (src/annotated_content.ts). This script
// once had a format of its own, so what I saw while troubleshooting was not what the model saw —
// which nearly led to a wrong conclusion last time. Every byte printed here is now the byte sent
// to the model.
import fs from "node:fs";
import path from "node:path";
import { renderAnnotatedContent } from "../dist/annotated_content.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const SNAP_DIR = process.env.EMBIODY_SNAPSHOT_DIR ?? "run/browser_data";
const round = opt("--round");
const grep = opt("--grep");
let file = args.find((a) => a.endsWith(".json"));

if (!file && round !== undefined) {
  // Pick the latest file for a round: one round may leave several files across runs, so take the largest timestamp.
  const hits = fs
    .readdirSync(SNAP_DIR)
    .filter((f) => f.includes(`_round${round}_`) && f.endsWith("_content.json"))
    .sort();
  file = hits.length ? path.join(SNAP_DIR, hits.at(-1)) : undefined;
  if (hits.length > 1) {
    console.log(
      `(round ${round} has ${hits.length} files; taking the latest. Older files for the same round come from earlier runs.)`,
    );
  }
}

if (!file) {
  console.error(
    "usage: node scripts/dump-snapshot.mjs <content.json> | --round N [--grep keyword]",
  );
  process.exit(1);
}

const raw = fs.readFileSync(file, "utf8");
const rendered = renderAnnotatedContent(raw);
const lines = rendered.split("\n").filter((l) => l.length);
const shown = grep
  ? lines.filter((l) => l.toLowerCase().includes(grep.toLowerCase()))
  : lines;

console.log(path.basename(file));
console.log(
  `raw JSON ${raw.length} chars -> rendered ${rendered.length} chars (${(100 - (100 * rendered.length) / raw.length).toFixed(0)}% saved)`,
);
console.log(
  `${lines.length} lines in total${grep ? `, ${shown.length} matching "${grep}"` : ""}\n`,
);
// The model receives Tab indentation; in a terminal a Tab expands to 8 columns and looks far too
// wide, so it is shown as two spaces here. Display only — the bytes match what the model sees.
for (const l of shown) console.log(l.replace(/\t/g, "  "));
if (!shown.length) console.log("(no matching lines)");
