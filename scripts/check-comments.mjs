// Structural checks on comments, run before the tests.
//
// `tsc` does not catch either of these. A `/**` that loses its closing `*/` swallows the code
// beneath it until the next `*/` turns up, and if what vanished is only used by tests or scripts,
// `npm run build` still passes while the export is silently missing from dist — that happened
// once and is why this file exists.
//
//   node scripts/check-comments.mjs
//
// Exits non-zero on the first problem found, so it can gate the test run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "test", "scripts"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|\.test-out|run|\.git)$/.test(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** A top-level declaration — deliberately not matching indented lines, so a multi-line import's continuation is not one. */
const DECLARATION = /^(export |async function |function |class |const |let |interface |type |enum |abstract )/;

const problems = [];

for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;

  for (const file of walk(full)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const lines = fs.readFileSync(file, "utf8").split("\n");

    let openedAt = 0;
    let sawDeclaration = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      const n = i + 1;

      if (openedAt) {
        if (t.includes("*/")) {
          // A block closed by a line that is only `*/`, with another `*/` right after it, means a
          // replacement left one behind.
          if (t === "*/" && lines[i + 1]?.trim() === "*/") {
            problems.push(`${rel}:${n + 1}: a stray */ directly after the one that closed this block`);
          }
          // A doc block followed by another doc block documents nothing — unless it is the file
          // header, which by definition comes before the first declaration.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (sawDeclaration && lines[j]?.trim().startsWith("/**")) {
            problems.push(
              `${rel}:${openedAt}: this doc block documents nothing — another /** follows it`,
            );
          }
          openedAt = 0;
        } else if (DECLARATION.test(line)) {
          problems.push(
            `${rel}:${n}: ${t.slice(0, 70)}\n    ...is inside the comment opened at line ${openedAt}; its */ is missing`,
          );
        }
        continue;
      }

      if (DECLARATION.test(line)) sawDeclaration = true;

      // Ignore a /* that sits inside a line comment or a string; good enough for our own source.
      const code = line.replace(/\/\/.*$/, "");
      const open = code.lastIndexOf("/*");
      if (open >= 0 && code.indexOf("*/", open) < 0) openedAt = n;
    }

    if (openedAt) problems.push(`${rel}:${openedAt}: this comment is never closed`);
  }
}

if (problems.length) {
  console.error("comment structure problems:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log("comment structure ok");
